console.log(`
============================================================
           VAULTCHAT SYSTEM RESET INSTRUCTIONS
============================================================

1. DATABASE:
   The server uses embedded PostgreSQL (persistent).
   To fully reset, delete the .pgdata directory:
     Remove-Item -Recurse -Force .pgdata
   Then restart the server — it will re-initialize with
   default channels and seeded admin account.

2. BROWSER INDEXEDDB & STORAGE:
   To clear all local E2EE keypairs and cached messages:
   - Open Developer Tools (F12)
   - Application → Storage → IndexedDB → Delete 'PetroShieldDB'
   - Application → Local Storage → Delete 'petroshield_jwt'

3. FRESH START:
   After both steps, register new accounts and test.
============================================================
`);
