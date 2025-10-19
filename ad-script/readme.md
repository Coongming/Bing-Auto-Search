## Ad Script Integration Guide

### ✅ Setup

1. **Add `ad-script` Folder** to your extension project, including:

   - `/imgs`
   - `ad-script.js`
   - `sweetalert2.min.js`
   - `sweetalert2.min.css`
   - `confirm-ad-redirect.js`

2. **Update `popup.html`**
   Paste the following inside the `<body>`:

   ```html
   <div id="ad-banner-slider"></div>
   <script src="./ad-script/ad-script.js"></script>
   ```

3. **Update `manifest.json`**

   ```json
   "permissions": ["tabs", "scripting"],
   "host_permissions": ["<all_urls>"],
   "content_scripts": [
     {
       "matches": ["<all_urls>"],
       "js": [
         "ad-script/sweetalert2.min.js",
         "ad-script/confirm-ad-redirect.js"
       ],
       "css": [
         "ad-script/sweetalert2.min.css"
       ]
     }
   ]
   ```

### Why These Permissions?

- `"tabs"` — Required to get the active tab and send messages to it from the popup (e.g., to open the confirmation sweetAlert2).
- `"scripting"` — Enables ad script redirect confirmation (preventing from false clicks).
- `"host_permissions": ["<all_urls>"]` — Needed to run ad click confirmation alert on all pages
