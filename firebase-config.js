/* ============================================================
   FIREBASE CONFIG  —  PASTE YOUR PROJECT'S WEB CONFIG BELOW
   ------------------------------------------------------------
   How to get these 7 values (takes ~2 minutes, free, no card):

   1. Go to  https://console.firebase.google.com  and click
      "Create a project" (name it anything, e.g. seshachalam-guardian).
      You can disable Google Analytics — not needed.

   2. In the left menu open  Build → Realtime Database  →  "Create Database".
      Pick a location, then choose  "Start in test mode"  and Enable.
      (Test mode is fine for a presentation. It expires in ~30 days.)

   3. Back on the project Overview, click the  </>  ("Web") icon to
      "Add app to get started". Give it a nickname, click Register.
      Firebase shows a  firebaseConfig = { ... }  object.

   4. Copy those values into the object below (keep the quotes).
      IMPORTANT: make sure "databaseURL" is included — if it's not in
      the snippet, copy it from the Realtime Database page (it looks like
      https://YOUR-PROJECT-default-rtdb.firebaseio.com ).

   These keys are MEANT to be public in client code — it is safe to
   commit this file. Access is controlled by the database rules, not
   by hiding the keys.
   ============================================================ */

window.FIREBASE_CONFIG = {
  apiKey: "PASTE_HERE",
  authDomain: "PASTE_HERE",
  databaseURL: "PASTE_HERE",   // <-- must end with firebaseio.com or firebasedatabase.app
  projectId: "PASTE_HERE",
  storageBucket: "PASTE_HERE",
  messagingSenderId: "PASTE_HERE",
  appId: "PASTE_HERE"
};
