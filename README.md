# Tertiary Tech presents PSL (Pakistan Superior League) - mock auction site

## Run it
    npm install
    npm start
Open http://localhost:3000. The console prints a Network address: your 8 friends open that on the same Wi-Fi.
For friends elsewhere, host it on any Node host (Render, Railway, a VPS) or tunnel it (e.g. `cloudflared tunnel --url http://localhost:3000`).

## Logins
On first start 9 logins are created (host + friend1..friend8, one per team) with random passwords.
They are printed in the console and saved in data/credentials.txt. The host can edit usernames, passwords,
display names and team assignment in Host console > Teams and logins, and copy them all to send to friends.

## Before the auction night
1. Log in as host > Host console > Data > "Load sample data" to see every page working (values are illustrative), or skip.
2. Players tab: drop an Excel/CSV (Name, Country, Base price, Role, Category) or paste rows. Prices accept 1.1, "60 lakh" or rupees.
   Rows with an unknown country or missing price are highlighted and get a flag dropdown / price box in the preview.
3. Signings tab: add direct signings and retentions per team. Purses update everywhere instantly.
4. Control centre: move the train (Direct Signing / Retention / Gaddafi Stadium) and choose what the Auction tab shows
   (Coming soon / Register yourself / Watch auction). Set timers and rules there too.
5. Add logos to public/assets (see the README there).

## On auction night
Auction tab > Next player (key N). Pause = Space, Sold = S, Unsold = U. Timer resets on each bid; "going once / twice" shows automatically.
Bidders see their own purse, a Bid button (key B) with the exact next price, Golden Paddle jumps, and Pass.

## Rules implemented (from the PSL 11 auction)
Purse Rs 45 Cr (+ up to Rs 5.5 Cr for a direct signing), squad 16-20, max 7 overseas, increments 0.025 / 0.05 / 0.10 / 0.15 Cr
(below 1.1 / 2.2 / 4.2 / above), Golden Paddle (bid several steps at once). All are editable in Control centre.
Optional "keep purse for minimum squad" rule (default Rs 0.6 Cr per empty slot, set to 0 to turn off).

Data is saved to data/state.json automatically. Run `npm test` for the end-to-end test.
