# X Scheduled Posting

A robust, self-hosted web application for scheduling and automatically posting tweets to X (formerly Twitter).

## Features
- **Queue Management**: Write tweets and schedule them or post them instantly.
- **Dynamic Scheduling**: Define daily "posting windows". The app will automatically assign upcoming tweets to the next available window, adding a few minutes of random "jitter" to appear more human.
- **Background Worker**: Uses APScheduler for reliable background task execution. Missed tweets (e.g., if the server is offline) are automatically shifted to the next available future window upon restart.
- **Security**: Secure authentication with automatic bcrypt password hashing.

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
