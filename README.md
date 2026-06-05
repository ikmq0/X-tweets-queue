# X Scheduled Posting

A robust, self-hosted web application for scheduling and automatically posting tweets to X (formerly Twitter).

## Features
- **Queue Management**: Write tweets and schedule them or post them instantly. You can easily reorder queued tweets by moving them up or down the queue.
- **Thread Scheduling**: Unlike native X tools, you can seamlessly write and schedule entire tweet threads at once with real-time character count validation.
- **Schedule Replies**: Schedule a tweet to be a reply to an existing X post by pasting the target URL.
- **Dynamic Scheduling**: Define daily "posting windows" (e.g., 8:00 AM, 12:00 PM). The app automatically assigns your queued tweets to the next available window, adding random "jitter" (a few minutes offset) to appear more human.
- **Background Worker**: Uses APScheduler for reliable background task execution. Missed tweets (e.g., if the server is offline) are automatically shifted to the next available future window upon restart.
- **Error Handling & Retries**: Failed tweets are automatically retried up to 3 times before being marked as failed. You can then review and retry them manually.
- **Bot Connection Status**: Easily verify your connection token validity and logged-in username directly from the UI.
- **Security**: Secure authentication with automatic bcrypt password hashing to protect your tool from unauthorized access.

## Why use this instead of X's Native Scheduler?
X (Twitter) has its own built-in scheduling tool, but this application offers several advanced capabilities that X does not natively support:
1. **Thread Scheduling**: X's native scheduler only supports scheduling single tweets. This tool allows you to write and schedule full multi-part threads.
2. **Scheduling Replies**: You cannot natively schedule a reply to an existing tweet on X. This tool lets you provide a "Reply To URL" so your scheduled tweet automatically replies to it.
3. **Queue-Based Workflow**: Instead of manually picking an exact date and time for every single tweet, you simply configure your "posting windows" once. Then, just add tweets to your queue, and the app will automatically distribute them across your windows.
4. **Humanized Jitter**: Automated posting at exactly "12:00:00" looks bot-like. This app adds random minute/second delays to your scheduled windows to mimic human behavior.

## Setup Instructions

1. **Clone the repository** and navigate to the project directory.

2. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

3. **Install Playwright Browsers**:
   ```bash
   playwright install chromium
   ```

4. **Environment Variables**:
   Create a `.env` file in the root directory.
   ```ini
   X_AUTH_TOKEN=your_twitter_auth_token_cookie_value
   ADMIN_USERNAME=admin
   ADMIN_PASSWORD=your_secure_password
   ```
   *Note: On first startup, the plaintext `ADMIN_PASSWORD` will automatically be hashed and replaced with `ADMIN_PASSWORD_HASH`.*

5. **Run the server**:
   ```bash
   python main.py
   ```
   The application will be available at `http://127.0.0.1:8000`.

## Docker Deployment

Alternatively, you can run the entire application using Docker.

1. **Build the Docker Image**:
   ```bash
   docker build -t x-tweets-queue .
   ```

2. **Run the Docker Container**:
   Make sure your `.env` file is created first.
   ```bash
   docker run -d -p 8000:8000 --env-file .env -v ${PWD}/data:/app/data --name x-tweets-queue x-tweets-queue
   ```
   *Note: We mount the `data` directory as a volume so your queue and settings persist even if the container restarts.*

## How to get your X_AUTH_TOKEN
1. Log into X (Twitter) in your browser.
2. Open Developer Tools (F12) -> Application tab -> Cookies -> `https://x.com`.
3. Find the cookie named `auth_token` and copy its value into your `.env` file.

## ⚠️ Disclaimer
This project is intended for educational and personal portfolio purposes only. It uses browser automation to interact with X.com, which may violate their Terms of Service. Use this software at your own risk. The creator is not responsible for any account suspensions, bans, or other actions taken by X.com as a result of using this tool.
