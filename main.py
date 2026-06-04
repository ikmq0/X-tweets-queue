import json
import os
import uuid
import asyncio
import random
import tempfile
from typing import Optional, List
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from fastapi import FastAPI, Request, Form, Depends, HTTPException, status, Response
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from dotenv import load_dotenv
from pydantic import BaseModel, Field
from contextlib import asynccontextmanager

load_dotenv()

# Scheduling Constants
RIYADH_TZ = ZoneInfo("Asia/Riyadh")
WINDOWS = [
    (7, 30),   # Morning Coffee
    (12, 0),   # Midday Break
    (17, 15),  # Afternoon Commute
    (21, 0)    # Evening Reading
]

SESSION_TTL_MINUTES = 30
MAX_RETRY_COUNT = 3

# Ensure directories exist
os.makedirs("data", exist_ok=True)
os.makedirs("static", exist_ok=True)
os.makedirs("templates", exist_ok=True)

# File paths
QUEUE_FILE = "data/queue.json"
SESSION_FILE = "data/sessions.json"
BOT_STATUS_FILE = "data/bot_status.json"

# App Credentials
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "adminpass")

# File locks to prevent race conditions between the worker and API
_queue_lock = asyncio.Lock()
_session_lock = asyncio.Lock()
_status_lock = asyncio.Lock()
_queue_wakeup = asyncio.Event()

# --- Pydantic Models ---

class TweetRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=280)
    post_now: bool = False

class EditTweetRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=280)

# --- File I/O Helpers (atomic writes) ---

def _load_json_sync(filepath, default):
    """Read JSON from file. Returns default if file missing or corrupt."""
    if not os.path.exists(filepath):
        _save_json_sync(filepath, default)
        return default
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return default

def _save_json_sync(filepath, data):
    """Atomic write: write to a temp file then rename, so a crash mid-write
    never corrupts the real file."""
    dir_name = os.path.dirname(filepath) or "."
    fd, tmp_path = tempfile.mkstemp(dir=dir_name, suffix=".tmp")
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
        # On Windows, os.rename fails if target exists, so use os.replace
        os.replace(tmp_path, filepath)
    except Exception:
        # Clean up temp file on failure
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise

async def load_json(filepath, default, lock: asyncio.Lock):
    """Thread-safe async JSON load."""
    async with lock:
        return await asyncio.to_thread(_load_json_sync, filepath, default)

async def save_json(filepath, data, lock: asyncio.Lock):
    """Thread-safe async JSON save (atomic)."""
    async with lock:
        await asyncio.to_thread(_save_json_sync, filepath, data)

async def load_and_save_json(filepath, default, lock: asyncio.Lock, modifier_fn):
    """Atomic read-modify-write under a single lock hold."""
    async with lock:
        data = await asyncio.to_thread(_load_json_sync, filepath, default)
        result = modifier_fn(data)
        await asyncio.to_thread(_save_json_sync, filepath, data)
        return result

# --- Auth Helpers ---

def _get_x_auth_token():
    """Re-read token from env each time so updates don't require restart."""
    load_dotenv(override=True)
    return os.getenv("X_AUTH_TOKEN", "")

async def get_current_user(request: Request):
    session_id = request.cookies.get("session_id")
    if not session_id:
        return None
    sessions = await load_json(SESSION_FILE, {}, _session_lock)
    session = sessions.get(session_id)
    if not session:
        return None
    # Check session expiry
    created_at = datetime.fromisoformat(session["created_at"])
    now = datetime.now(RIYADH_TZ)
    if now - created_at > timedelta(minutes=SESSION_TTL_MINUTES):
        # Session expired — remove it
        def remove_session(data):
            if session_id in data:
                del data[session_id]
        await load_and_save_json(SESSION_FILE, {}, _session_lock, remove_session)
        return None
    return session.get("username")

async def require_auth(request: Request):
    user = await get_current_user(request)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired. Please log in again.")
    return user

# --- Scheduling Algorithm ---

def get_next_available_slot(queue_data):
    now = datetime.now(RIYADH_TZ)

    queued_items = queue_data.get("queued", [])
    if queued_items:
        last_item = max(queued_items, key=lambda x: datetime.fromisoformat(x["scheduled_at"]))
        last_dt = datetime.fromisoformat(last_item["scheduled_at"])
        base_dt = max(last_dt, now)
    else:
        base_dt = now

    current_date = base_dt.date()

    # Try today's windows
    for hour, minute in WINDOWS:
        window_dt = datetime(current_date.year, current_date.month, current_date.day, hour, minute, tzinfo=RIYADH_TZ)
        if window_dt > base_dt:
            jitter_minutes = random.randint(1, 20)
            jitter_seconds = random.randint(0, 59)
            return window_dt + timedelta(minutes=jitter_minutes, seconds=jitter_seconds)

    # All today's windows are past — roll to tomorrow's first window
    next_date = current_date + timedelta(days=1)
    hour, minute = WINDOWS[0]
    window_dt = datetime(next_date.year, next_date.month, next_date.day, hour, minute, tzinfo=RIYADH_TZ)
    jitter_minutes = random.randint(1, 20)
    jitter_seconds = random.randint(0, 59)
    return window_dt + timedelta(minutes=jitter_minutes, seconds=jitter_seconds)

# --- Playwright Automation ---

async def post_tweet(content: str):
    token = _get_x_auth_token()
    if not token:
        return "SYSTEM_ERROR", "X_AUTH_TOKEN is missing in .env file."

    browser = None
    try:
        from playwright.async_api import async_playwright
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context()

            await context.add_cookies([{
                "name": "auth_token",
                "value": token,
                "domain": ".x.com",
                "path": "/",
                "secure": True,
                "httpOnly": True
            }])

            page = await context.new_page()
            await page.goto("https://x.com/compose/post")

            # Check if redirected to login or locked page
            await page.wait_for_load_state("domcontentloaded")
            current_url = page.url
            if "login" in current_url:
                return "SYSTEM_ERROR", "Failed to authenticate. Your X_AUTH_TOKEN is invalid or expired."
            if "locked" in current_url or "suspend" in current_url or "challenge" in current_url:
                return "SYSTEM_ERROR", "Account locked by X.com. Please log in manually on your browser to resolve the CAPTCHA or phone verification."

            # Wait for the tweet textbox
            try:
                await page.wait_for_selector('[data-testid="tweetTextarea_0"]', timeout=15000)
            except Exception:
                return "SYSTEM_ERROR", "Browser timeout: X.com took too long to respond or the website layout changed."

            await page.fill('[data-testid="tweetTextarea_0"]', content)
            await page.click('[data-testid="tweetButton"]')

            # Verify the tweet was posted by waiting for any toast notification
            try:
                toast = await page.wait_for_selector('[data-testid="toast"]', state="visible", timeout=10000)
                toast_text = await toast.inner_text()
                toast_text_lower = toast_text.lower()
                
                if "sent" in toast_text_lower:
                    print("Tweet posted successfully — success toast appeared.")
                    return "SUCCESS", "Posted successfully."
                elif "already sent" in toast_text_lower:
                    return "TWEET_ERROR", "Duplicate tweet detected by X.com."
                elif "limit" in toast_text_lower:
                    return "SYSTEM_ERROR", f"Rate limit reached: {toast_text}"
                else:
                    return "TWEET_ERROR", f"X.com rejected post: {toast_text}"
            except Exception:
                # If toast didn't appear, it timed out
                return "SYSTEM_ERROR", "Browser timeout: Tweet button clicked but X.com did not confirm success with a toast."

    except Exception as e:
        print(f"Failed to post tweet: {e}")
        return "SYSTEM_ERROR", f"Playwright browser error: {str(e)}"
    finally:
        if browser:
            try:
                await browser.close()
            except Exception:
                pass

# --- Background Worker ---

async def process_queue_worker():
    while True:
        try:
            queue_data = await load_json(QUEUE_FILE, {"queued": [], "posted": [], "failed": []}, _queue_lock)

            # Find items that are ready to post (scheduled_at <= now)
            ready_items = [item for item in queue_data.get("queued", []) if datetime.now(RIYADH_TZ) >= datetime.fromisoformat(item["scheduled_at"])]

            for item_to_post in ready_items:
                print(f"Time to post! Attempting item: {item_to_post['id']} (attempt {item_to_post.get('retry_count', 0) + 1})")
                
                status, message = await post_tweet(item_to_post["content"])

                if status == "SUCCESS":
                    def move_to_posted(data):
                        data["queued"] = [x for x in data["queued"] if x["id"] != item_to_post["id"]]
                        item_to_post["posted_at"] = datetime.now(RIYADH_TZ).isoformat()
                        item_to_post["last_error"] = None
                        if "posted" not in data:
                            data["posted"] = []
                        data["posted"].append(item_to_post)
                    await load_and_save_json(QUEUE_FILE, {"queued": [], "posted": [], "failed": []}, _queue_lock, move_to_posted)
                elif status == "TWEET_ERROR":
                    def handle_tweet_failure(data):
                        target = next((x for x in data["queued"] if x["id"] == item_to_post["id"]), None)
                        if target:
                            target["retry_count"] = target.get("retry_count", 0) + 1
                            target["last_error"] = message
                            if target["retry_count"] >= 3:
                                data["queued"].remove(target)
                                target["failed_at"] = datetime.now(RIYADH_TZ).isoformat()
                                if "failed" not in data:
                                    data["failed"] = []
                                data["failed"].append(target)
                    await load_and_save_json(QUEUE_FILE, {"queued": [], "posted": [], "failed": []}, _queue_lock, handle_tweet_failure)
                elif status == "SYSTEM_ERROR":
                    print(f"System Error encountered: {message}")
                    # Update bot status UI globally
                    status_data = {
                        "status": "Error",
                        "last_checked": datetime.now(RIYADH_TZ).isoformat(),
                        "last_message": message
                    }
                    # Keep x_username if it exists in current status
                    try:
                        with open(BOT_STATUS_FILE, "r") as f:
                            old_status = json.load(f)
                        if old_status.get("x_username"):
                            status_data["x_username"] = old_status["x_username"]
                    except Exception:
                        pass
                        
                    await save_json(BOT_STATUS_FILE, status_data, _status_lock)
                    
                    # Shift in queue without consuming retry
                    def shift_system_error(data):
                        target = next((x for x in data["queued"] if x["id"] == item_to_post["id"]), None)
                        if target:
                            data["queued"].remove(target)
                            target["scheduled_at"] = get_next_available_slot(data).isoformat()
                            target["last_error"] = f"System Error: {message}"
                            data["queued"].append(target)
                            data["queued"] = sorted(data["queued"], key=lambda x: x["scheduled_at"])
                    await load_and_save_json(QUEUE_FILE, {"queued": [], "posted": [], "failed": []}, _queue_lock, shift_system_error)

        except Exception as e:
            print(f"Error in queue worker: {e}")

        try:
            await asyncio.wait_for(_queue_wakeup.wait(), timeout=60)
            _queue_wakeup.clear()
        except asyncio.TimeoutError:
            pass

# --- App Lifespan ---

@asynccontextmanager
async def lifespan(app):
    worker_task = asyncio.create_task(process_queue_worker())
    yield
    worker_task.cancel()

app = FastAPI(title="X Scheduled Posting", lifespan=lifespan)

# Mount static files and templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# --- Routes ---

@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request):
    user = await get_current_user(request)
    return templates.TemplateResponse(request=request, name="index.html", context={"user": user})

@app.post("/login")
async def login(request: Request, response: Response, username: str = Form(...), password: str = Form(...)):
    if username == ADMIN_USERNAME and password == ADMIN_PASSWORD:
        session_id = str(uuid.uuid4())

        def add_session(data):
            data[session_id] = {"username": username, "created_at": datetime.now(RIYADH_TZ).isoformat()}
        await load_and_save_json(SESSION_FILE, {}, _session_lock, add_session)

        response = RedirectResponse(url="/", status_code=status.HTTP_302_FOUND)
        response.set_cookie(key="session_id", value=session_id, httponly=True, samesite="Strict")
        return response
    return templates.TemplateResponse(request=request, name="index.html", context={"user": None, "error": "Invalid credentials"})

@app.get("/logout")
async def logout(request: Request, response: Response):
    session_id = request.cookies.get("session_id")
    if session_id:
        def remove_session(data):
            if session_id in data:
                del data[session_id]
        await load_and_save_json(SESSION_FILE, {}, _session_lock, remove_session)

    response = RedirectResponse(url="/", status_code=status.HTTP_302_FOUND)
    response.delete_cookie("session_id")
    return response

@app.get("/api/queue")
async def get_queue(user: str = Depends(require_auth)):
    queue_data = await load_json(QUEUE_FILE, {"queued": [], "posted": [], "failed": []}, _queue_lock)
    queue_data["queued"] = sorted(queue_data.get("queued", []), key=lambda x: x["scheduled_at"])
    return queue_data

@app.post("/api/queue")
async def add_tweet(tweet: TweetRequest, user: str = Depends(require_auth)):
    result = {}

    def add_item(data):
        nonlocal result
        if "failed" not in data:
            data["failed"] = []
            
        if tweet.post_now:
            scheduled_dt = datetime.now(RIYADH_TZ)
        else:
            scheduled_dt = get_next_available_slot(data)
            
        new_item = {
            "id": str(uuid.uuid4()),
            "content": tweet.content.strip(),
            "created_at": datetime.now(RIYADH_TZ).isoformat(),
            "scheduled_at": scheduled_dt.isoformat(),
            "retry_count": 0
        }
        data["queued"].append(new_item)
        data["queued"] = sorted(data["queued"], key=lambda x: x["scheduled_at"])
        result = new_item

    await load_and_save_json(QUEUE_FILE, {"queued": [], "posted": [], "failed": []}, _queue_lock, add_item)
    _queue_wakeup.set()
    return {"message": "Tweet added", "item": result}

@app.put("/api/queue/{item_id}")
async def edit_tweet(item_id: str, tweet: EditTweetRequest, user: str = Depends(require_auth)):
    found = {"item": None}

    def update_item(data):
        for item in data["queued"]:
            if item["id"] == item_id:
                item["content"] = tweet.content.strip()
                found["item"] = item
                return

    await load_and_save_json(QUEUE_FILE, {"queued": [], "posted": [], "failed": []}, _queue_lock, update_item)

    if not found["item"]:
        raise HTTPException(status_code=404, detail="Tweet not found in queue.")
    return {"message": "Tweet updated", "item": found["item"]}

@app.delete("/api/queue/{item_id}")
async def delete_tweet(item_id: str, user: str = Depends(require_auth)):
    def remove_item(data):
        data["queued"] = [item for item in data["queued"] if item["id"] != item_id]
        
        # Recompute the schedule for all remaining items to fill any gaps
        if data["queued"]:
            old_queued = sorted(data["queued"], key=lambda x: x["scheduled_at"])
            data["queued"] = []
            for item in old_queued:
                item["scheduled_at"] = get_next_available_slot(data).isoformat()
                data["queued"].append(item)

    await load_and_save_json(QUEUE_FILE, {"queued": [], "posted": [], "failed": []}, _queue_lock, remove_item)
    return {"message": "Tweet removed from queue"}

@app.post("/api/queue/{item_id}/retry")
async def retry_failed_tweet(item_id: str, user: str = Depends(require_auth)):
    """Move a failed tweet back into the queue with a fresh schedule."""
    found = {"item": None}

    def move_back(data):
        if "failed" not in data:
            data["failed"] = []
        for i, item in enumerate(data["failed"]):
            if item["id"] == item_id:
                retried_item = data["failed"].pop(i)
                retried_item["retry_count"] = 0
                retried_item.pop("last_error", None)
                retried_item.pop("failed_at", None)
                retried_item["scheduled_at"] = get_next_available_slot(data).isoformat()
                data["queued"].append(retried_item)
                data["queued"] = sorted(data["queued"], key=lambda x: x["scheduled_at"])
                found["item"] = retried_item
                return

    await load_and_save_json(QUEUE_FILE, {"queued": [], "posted": [], "failed": []}, _queue_lock, move_back)

    if not found["item"]:
        raise HTTPException(status_code=404, detail="Failed tweet not found.")
    return {"message": "Tweet moved back to queue", "item": found["item"]}

@app.delete("/api/failed/{item_id}")
async def delete_failed_tweet(item_id: str, user: str = Depends(require_auth)):
    def remove_item(data):
        if "failed" not in data:
            data["failed"] = []
        data["failed"] = [item for item in data["failed"] if item["id"] != item_id]

    await load_and_save_json(QUEUE_FILE, {"queued": [], "posted": [], "failed": []}, _queue_lock, remove_item)
    return {"message": "Failed tweet dismissed"}

# --- Bot Status ---

@app.get("/api/bot/status")
async def get_bot_status(user: str = Depends(require_auth)):
    status_data = await load_json(BOT_STATUS_FILE, {
        "status": "Unknown",
        "last_checked": None,
        "last_message": "Bot has not been verified yet."
    }, _status_lock)
    return status_data

@app.post("/api/bot/verify")
async def verify_bot(user: str = Depends(require_auth)):
    token = _get_x_auth_token()

    if not token:
        status_data = {
            "status": "Invalid",
            "last_checked": datetime.now(RIYADH_TZ).isoformat(),
            "last_message": "X_AUTH_TOKEN is missing in .env file."
        }
        await save_json(BOT_STATUS_FILE, status_data, _status_lock)
        return status_data

    browser = None
    try:
        from playwright.async_api import async_playwright
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context()
            await context.add_cookies([{
                "name": "auth_token",
                "value": token,
                "domain": ".x.com",
                "path": "/",
                "secure": True,
                "httpOnly": True
            }])
            page = await context.new_page()
            await page.goto("https://x.com/home")

            try:
                await page.wait_for_selector('[data-testid="tweetTextarea_0"]', timeout=10000)
                
                # Try to extract the logged-in X username
                x_username = None
                try:
                    profile_link = await page.get_attribute('[data-testid="AppTabBar_Profile_Link"]', 'href', timeout=5000)
                    if profile_link:
                        x_username = "@" + profile_link.strip('/')
                except Exception:
                    pass

                status_data = {
                    "status": "Valid",
                    "x_username": x_username,
                    "last_checked": datetime.now(RIYADH_TZ).isoformat(),
                    "last_message": f"Token is valid. Logged in as {x_username if x_username else 'unknown'}."
                }
            except Exception:
                status_data = {
                    "status": "Invalid",
                    "x_username": None,
                    "last_checked": datetime.now(RIYADH_TZ).isoformat(),
                    "last_message": "Failed to authenticate. Token may be expired or invalid."
                }
    except Exception as e:
        status_data = {
            "status": "Error",
            "last_checked": datetime.now(RIYADH_TZ).isoformat(),
            "last_message": f"Browser error: {str(e)}"
        }
    finally:
        if browser:
            try:
                await browser.close()
            except Exception:
                pass

    await save_json(BOT_STATUS_FILE, status_data, _status_lock)
    return status_data

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
