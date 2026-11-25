# Ledger — Finance Ops App

> **Update:** the database is now **Neon** (not a Render database). Ignore the Render database steps below.
> Set `DATABASE_URL` on Render to your Neon link.

A small internal app for 2 operators + 1 accountant: invoice upload, revenue
booking, ageing, bank statement upload/reconciliation, dashboard, financial
statements, and a board deck. Node/Express backend, Postgres database, plain
HTML/JS frontend (no build step).

## What changed from the prototype

The Claude-artifact prototype used `window.storage`, which only works inside
claude.ai. This version replaces that with:
- A real Express API (`server/`)
- A Postgres database (one `users` table for login, one `ledger` table holding
  the shared company data as JSON — simple and reliable at this scale)
- Real username/password login (JWT-based sessions)

**Known limitation:** the whole company ledger is saved as one JSON document
per save, and any signed-in user can call the save endpoint. The UI hides
accountant-only screens from operators, but there's no server-side,
per-action permission check yet. Fine for a small trusted team; if that ever
matters, the natural next step is splitting `/api/state` into per-entity
endpoints (`/api/invoices`, `/api/expenses`, etc.) with role checks on each.

## 1. Run it locally (optional, but good for testing first)

You'll need Node.js 18+ and a local Postgres, or a free one from
[Neon](https://neon.tech) or [Supabase](https://supabase.com) if you don't
want to install Postgres locally.

```bash
cd server
cp .env.example .env
# edit .env: set DATABASE_URL to your local/remote Postgres connection string

npm install
psql "$DATABASE_URL" -f schema.sql   # creates the tables
npm run seed                          # creates the 3 demo users
npm start                             # starts on http://localhost:3000
```

Open `http://localhost:3000` and sign in with one of the seeded accounts
(see `server/seed.js` for the default usernames/passwords — change them).

## 2. Push to GitHub

```bash
cd finance-ops-app
git init
git add .
git commit -m "Finance ops app"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## 3. Deploy on Render

**Easiest: Blueprint deploy (uses `render.yaml`)**
1. Go to the Render dashboard → **New** → **Blueprint**.
2. Connect your GitHub account and pick this repo.
3. Render reads `render.yaml` and provisions both the web service and a free
   Postgres database automatically, wiring `DATABASE_URL` and generating a
   `JWT_SECRET` for you.
4. Click **Apply**. First deploy takes a few minutes.

**Manual alternative, if you'd rather not use the blueprint:**
1. **New** → **PostgreSQL** → create a free database, note its connection string.
2. **New** → **Web Service** → connect the repo.
   - Build command: `cd server && npm install`
   - Start command: `cd server && node index.js`
   - Add environment variables: `DATABASE_URL` (from the database you just
     made) and `JWT_SECRET` (any long random string).

## 4. Set up the database on Render (one-time)

Once the web service and database both exist, open the **Shell** tab on the
web service's Render page (no local tools needed — this runs in Render's
browser terminal, which already has `DATABASE_URL` set) and run:

```bash
cd server
npm run setup
```

This creates the tables and the 3 demo users in one go, and prints the
usernames/passwords you can sign in with.

## 5. First login, then lock it down

Sign in with the seeded accounts (`server/seed.js`), then:
- Change the default passwords — easiest is to edit the passwords in
  `seed.js` and re-run `npm run seed` (it upserts by username), or add a
  proper "change password" endpoint later.
- Consider restricting who can reach the app (e.g. Render's IP allow-listing
  on paid plans, or just relying on unique passwords for now, given it's a
  3-person team).

## 6. Ongoing use

- Any of the 3 users can sign in from any device with a browser — data is
  shared and stored in Postgres, so it persists and stays in sync.
- To update the app, push changes to GitHub; Render redeploys automatically
  on push to `main` (configurable in the service settings).

## 7. Bank allocation (accountant)

The accountant has one master screen, **Bank allocation**:
1. Load the bank statement (Excel `.xlsx`/`.xls` or CSV). Check the column choices in the preview, then Import.
2. Select a bank line. Money in is allocated to customer invoices (full or part payment);
   money out is allocated to supplier vouchers that have been posted. Anything else
   (bank charges, salaries, tax...) can be marked as "Other".
3. Allocating money in creates an approved payment, so invoice balances and the Ageing update immediately.
   Allocating money out reduces the supplier balance and the new "Payables ageing".
4. The Control check at the top shows when every bank line is allocated.

Every allocation can be undone. Operators no longer see the old Bank statements / Reconciliation pages.

## 8. Bank reconciliation report (accountant)

**Bank reconciliation** (menu) gives a formatted report, as a screen, PDF, Excel or print:
- Opening balance, money in, money out, closing balance per the bank statement
- Receipts recorded in the books but not yet cleared by the bank
- Payments recorded in the books but not yet processed by the bank
- Bank lines not yet allocated
- Adjusted balance, compared with the **Bank** figure on the balance sheet (difference should be 0.00)

The Bank figure on the balance sheet / dashboard / board deck is now:
opening balance (first statement) + customer payments recorded - supplier payments recorded +/- other bank items allocated.
Payments dated before the first statement line are treated as already inside the opening balance.

## 9. Allocation references and statements of account

Every allocation gets a reference (AL-00001, AL-00002...). It appears:
- on the bank line (Bank allocation screen) and in the searchable **Allocation register**
- on the Payments screen (Allocation ref column) and on remittance PDFs
- on the customer **Statement of account**, which also shows which payment settled which
  invoice, the bank reference, the allocation reference, and the ageing of the balance due

The layout now uses the full screen width and works on phones and tablets (menu button at the top left).

## 10. Allocation screen: frozen panel

The bank list and the allocation panel scroll independently, so the panel for the selected
line stays in view while you scroll the list. Money-in lines only offer customer invoices and
other receipts; money-out lines only offer supplier vouchers and other payments.

## 11. Bank statement details and "Update descriptions"

Every column of the bank file (Transaction ID, Cheque Number, Value Date, Description...) is saved with each bank line
and shown in the allocation panel. For a statement loaded before this, use **Update descriptions** in the
"Statements loaded" table and choose the same bank file again: descriptions, references and details are filled in
(matched by date and amount, and the Transaction ID). Amounts and allocations are never changed.

## 12. Loading a bank statement again (sync)

Loading a file never duplicates what is already there. Each line is matched on date + amount + an identifier
(Transaction ID / Cheque Number); descriptions are only a fallback. Lines already loaded are kept with their allocations,
only genuinely new lines are added, and a next-month file is appended (its opening balance is checked against the
previous closing balance). Lines we hold that the new file no longer has can optionally be removed (never if allocated).
"Check for duplicate lines" (Statements loaded) finds and removes second copies that nobody has allocated.

## 13. Start again (reset bank data) and password control

On the Bank allocation screen, **Start again (reset bank data)** cancels every bank allocation and deletes all bank
statements so a fresh statement can be loaded. Deleting a statement, or resetting, asks the accountant for their
username and password again (checked on the server: 5 wrong tries lock it for 10 minutes). A backup file of the bank
data downloads first. Invoices, customers, suppliers, vouchers and payments entered on the Payments screen are not deleted.
Allocation references (AL-) never restart after a reset.

Bank statements and allocations can only be changed by the accountant (also enforced on the server).
Loading a file that would mostly duplicate lines already held shows a warning first.

## 14. Bookings from the bank (financial statements)

Allocating a bank line to an account books it into the financial statements:
- Money in: Dr Bank, Cr the chosen account (Interest income -> P&L; Loans payable -> balance sheet liability;
  VAT refund -> VAT recoverable; Capital -> equity; transfer from own account -> asset).
- Money out: Dr the chosen account, Cr Bank (Bank charges / Interest expense -> P&L; Loan repayment, VAT paid,
  PAYE/CSG/NPF/salaries paid -> reduce the liability; Drawings -> equity; transfer to own account -> asset).
- "of which VAT" splits the VAT into VAT recoverable (money out) or VAT payable (money in).
The P&L shows sales excluding VAT, other income, and expenses paid through the bank. The balance sheet shows VAT payable
(VAT on sales less VAT paid), VAT recoverable, payroll payable, loans, other assets and an Equity section.
"Bookings from the bank (journal)" on the Financial statements page lists every entry (debits = credits).
Items marked "Other" in older versions stay as "Unclassified bank items" until classified (Classify them, on Bank allocation).

## 15. Reports: trial balance, financial pack and schedules

The **Reports** menu builds a general ledger from every source (invoices, customer receipts, supplier vouchers, payroll,
supplier payments and the bank bookings) and produces, as PDF or Excel:
- a Trial balance (debits = credits, checked),
- a Financial pack: contents, Profit and loss, Balance sheet, Trial balance and a numbered schedule (Note 1, 2, 3...)
  for every caption listing its transactions with a running balance. The Excel pack has one sheet per note plus an Index.
Optional From / To dates give a period P&L and a balance sheet as at a date (earlier results move to equity).
With no dates the figures must agree with the Financial statements page; the page shows a check for this.
"The opening balances and earlier results (balancing figure)" schedule shows what it is made of.

## 16. Public home page

Visitors who are not signed in see a public home page (hero, services, packages, how it works, news, FAQ, contact).
The Log In tab at the top right drops down the sign-in form (and a Request access form).
To change the business name, phone, email, address, services, news items and FAQs, open `public/index.html`
and search for **EDIT YOUR BUSINESS DETAILS HERE**: everything is in one block of plain text.
The contact and request forms open the visitor's email app with the message ready to send.

## 17. Security hardening

Added without changing how the app looks or works:
- **Sign-in lockout:** 5 wrong passwords for a username from the same device/network lock that combination for
  15 minutes (20 wrong attempts from one IP lock that IP). Unknown usernames take as long to answer as real ones.
- **Sessions are checked on every request:** the server confirms the user still exists and that their password has not
  changed, and takes the role from the database. Changing a password (or deleting a user) signs out their old sessions.
  Tokens are pinned to HS256. Everyone is asked to sign in once after this update.
- **Strong secret required:** on Render the server will not start unless `JWT_SECRET` is 32+ characters
  (the blueprint generates one automatically).
- **Security headers:** anti-framing (clickjacking), no MIME sniffing, HSTS over https, strict referrer, locked-down
  browser permissions, and `no-store` on all API responses. Other websites get no CORS access to the API
  (set `ALLOWED_ORIGINS` only if you ever host the front end elsewhere).
- **Request limits:** 600 API requests per minute per IP; bad or oversized requests get a short error, never a stack trace.
- **Passwords no longer reset on deploy:** `setup.js` (run by the Render build) now only creates missing users.
  Before, every deploy put all three passwords back to the defaults. To deliberately reset to the defaults in
  `setup.js`, run `RESET_PASSWORDS=1 npm run setup`.
- **Change a password on the Render free plan (no Shell needed):** in Render open your service -> **Environment** ->
  add `PASSWORD_ALINE`, `PASSWORD_VIKASH` and `PASSWORD_PRIYA` with the new passwords (10+ characters) -> Save.
  Render redeploys and applies them (and signs those users out). The passwords stay in Render's private settings,
  not in GitHub. If you later remove a variable, that password simply stays as it is.
- **Change a password with a Shell** (paid plan or your own computer): `cd server && npm run passwd -- aline "a-long-new-password"`.

**Do this after deploying:** change all three default passwords (Environment settings or `npm run passwd`), because `changeme1/2/3` are
visible in this repository. Also remove the default passwords from `setup.js` and `seed.js` if the repo is public.

## 18. Supplier invoice fields and the invoice mapping table

The app now holds the fields an invoice reader (bot) needs, and the `mapping/invoice_mapping_table.xlsx` workbook
describes how each invoice field maps to them.
- **Suppliers:** Usual type of expense, Payment terms, Bank account and Also known as (other names on invoices).
- **Expense vouchers:** Invoice no. and Due date columns ("Date" is now Invoice date). Choosing a supplier fills its usual
  type of expense and the due date (invoice date + payment terms). The same supplier invoice number cannot be entered twice.
- **Posted expenses** keep the supplier invoice number.
Nothing else changes: existing suppliers and vouchers keep working (the new fields are simply blank on them).

## 19. Invoice bot (mailbox + uploaded scans)

**Flow:** invoice arrives (invoices Gmail, or a scan uploaded on the **Invoice inbox** screen) -> the bot reads it and checks it
against the Suppliers screen and the review rules -> it is HELD in the Invoice inbox -> **Aline** checks it against the original and
clicks *Validate and send to Priya* -> it appears on **Expense vouchers** as "Awaiting posting" -> **Priya** posts it (journal) or returns it.
The bot never posts anything. Only the usernames in `BOT_VALIDATORS` (default `aline`) can validate or reject; the server enforces it.

**Settings to add in Render -> your service -> Environment** (never put these in GitHub):

| Key | Value |
|---|---|
| `ANTHROPIC_API_KEY` | key from console.anthropic.com (reads the invoices; costs a few cents per invoice) |
| `GMAIL_USER` | the invoices Gmail address |
| `GMAIL_APP_PASSWORD` | the 16-letter Google *App password* (Google Account -> Security -> 2-Step Verification -> App passwords) |
| `BOT_CRON_KEY` | any long random text, 24+ characters (you make it up; the daily timer uses the same text) |
| `BOT_VALIDATORS` | optional, default `aline` |
| `BOT_ALLOWED_SENDERS` | optional: only read mail from these addresses or domains |

**Daily timer (free, GitHub Actions):** the file `.github/workflows/invoice-bot.yml` starts the check every day at 07:00 Mauritius time.
In GitHub open your repository -> Settings -> Secrets and variables -> Actions -> New repository secret and add two secrets:
`BOT_URL` (your app address, e.g. `https://finance-ops-app.onrender.com`) and `BOT_CRON_KEY` (the same text as in Render).
To test: Actions tab -> Daily invoice check -> Run workflow. Aline can also press **Check mailbox now** on the Invoice inbox screen.
If the folder `.github` is hidden when you upload to GitHub, use Add file -> Create new file, type `.github/workflows/invoice-bot.yml` as the name and paste the contents.
GitHub may pause scheduled jobs on public repositories after 60 days without activity; keep the repository private.

**What the bot does and does not do**
- Looks at emails of the last 14 days, up to 30 new emails per check. PDFs and photos only; small images (logos, signatures) are ignored.
- The same file or the same Message-ID is never read twice. The same supplier + invoice number is flagged as a duplicate and blocked on validation.
- Flags (red) are listed in `mapping/invoice_mapping_table.xlsx` -> Review_Rules: unknown supplier, totals not adding up, foreign currency, changed bank details, VAT without a VAT number, etc.
- Credit notes are flagged and cannot be validated (reject and enter manually). Foreign-currency invoices are held for review.
- Invoice files are stored in the database (about 100-500 KB each) so Priya can open the original from the voucher.
- Text inside an invoice is treated as data, never as instructions, and the bot can only create held entries.
- Keyword rules for suggesting an expense type live in `server/mapping.json` (same content as the Account_Map sheet).

## 20. Home page animation

The public home page hero now shows an animated AI head (`public/ai-head.jpg`) in place of the VAT calculator. The head floats gently,
glows, is scanned by a light band, and is wired into a finance network: invoices flow into it, it pulses, and the head flashes as data arrives,

and a line under the buttons showing the steps (read, match, flag, approve, reconcile). It is visual only; all home page text,
the VAT calculator, links and forms are unchanged. It pauses when the page is not visible and is switched off automatically for
visitors who have "reduce motion" turned on in their device. The code is in `public/index.html` (search for "Hero animation").

The "Month-end" card in the About section is now a holographic AI-style dashboard (glowing bars, a trend line with an "AI forecast",
an "Ai" chip and a scanning light). The text is unchanged and the figures are for illustration only. Search `pub-ai-chart` in `public/index.html`.
