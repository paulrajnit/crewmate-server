# CrewMate Server

Backend for the CrewMate app. Handles CWP login and roster fetching for Jetstar NZ crew.

## Security model
- Passwords are **never stored**. Used once to log in, then discarded.
- Only session cookies are kept — in memory, not on disk.
- Sessions expire after 4 hours automatically.
- HTTPS enforced by Railway.

## Deploy to Railway (free)

1. Go to railway.app → sign up with GitHub
2. New Project → Deploy from GitHub repo
3. Upload this folder as a new repo (or push via git)
4. Railway auto-detects Node.js and deploys
5. Your server URL will be something like `crewmate-server.railway.app`

## API endpoints

### POST /login
```json
{ "username": "674953", "password": "yourpassword" }
```
Returns:
```json
{ "success": true, "token": "abc123...", "expiresInHours": 4 }
```

### GET /roster
Header: `Authorization: Bearer <token>`

Returns parsed roster data.

### POST /logout  
Header: `Authorization: Bearer <token>`

Clears the session.

### GET /status
Health check — shows uptime and active session count.

## Update CrewMate app

Once deployed, add your Railway URL to the CrewMate app:
- Open crewmate-v5.jsx
- Find `const SERVER_URL`
- Set it to your Railway URL

Then the app will show a "Connect to CWP" button that logs in via the server.

## Local dev

```bash
npm install
npm run dev
```
Server runs on http://localhost:3000
