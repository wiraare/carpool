# Site log (just for me)

This is a Google Apps Script. The carpool site sends it a small note whenever someone opens the site, plans a carpool, copies a share link, unlocks the group list or runs into an error. Each note gets saved in a Google Sheet that only I own, and the script also serves a dashboard. If anyone else opens the link, they only see "Nothing here."

It doesn't log names, addresses or what's in share links. It only logs a random id per browser, the device and browser type, language, time zone, and which site sent them there.

## Setup

1. Go to script.google.com and click **New project**. Name it something like "Carpool log".
2. Paste `Code.gs` over everything in the `Code.gs` file there.
3. Click **+** next to Files, choose **HTML**, name it `Dashboard`, and paste `Dashboard.html` into it.
4. Pick `setup` in the function dropdown at the top and click **Run**. Google asks for permission, so allow it. This also makes the "Carpool site log" sheet in your Drive.
5. Click **Deploy > New deployment**, choose the gear icon and pick **Web app**. Set "Execute as" to **Me** and "Who has access" to **Anyone**, then click Deploy.
6. Copy the web app link (it ends in `/exec`). Put it in `config.js` as `logUrl`, then upload.

To see the dashboard, open that same `/exec` link while signed in to your Google account. Bookmark it.

If you change `Code.gs` later, go to **Deploy > Manage deployments**, click the pencil, pick **New version** and deploy. The link stays the same.

To stop logging your own visits, open the site once as `https://wiraare.github.io/carpool/?nolog`. Use `?log` to turn it back on.
