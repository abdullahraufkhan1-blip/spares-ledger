# Put it on the cloud (no Node on your PC, ever)

## Railway (simplest)
1. Put the spares-app folder in a GitHub repository (github.com -> New repository ->
   upload the folder contents; keep it PRIVATE - the database is inside).
2. railway.app -> sign in with GitHub -> New Project -> Deploy from GitHub repo -> pick it.
   Railway detects the Dockerfile and builds everything (Node AND the Python upload support).
3. In the service: Settings -> Networking -> Generate Domain. That https URL is your app.
4. IMPORTANT - persistent disk:
   a. Right-click the service -> Attach Volume -> mount path: /data
   b. Service -> Variables -> add:  DB_PATH = /data/inventory.db
   c. Redeploy. First boot copies the bundled June database onto the volume;
      from then on your data survives every restart and update.
5. Open the URL, sign in admin / ChangeMe123!, change the password, create users.
6. Phones: open the URL -> "Add to Home screen". Done - it behaves like an installed app.

## Render (alternative, same idea)
New -> Web Service -> connect repo -> it uses the Dockerfile. Add a Disk (mount /data) and set env DB_PATH=/data/inventory.db.
Free tier sleeps when idle; the $7 tier stays awake.

Updates later: replace files in the GitHub repo -> the platform redeploys automatically.
