# Party CRM – setup guide (no IT skills needed)

## Step 1 – Put the files on GitHub
1. Unzip this folder on your computer.
2. Create a free account at github.com, click **New repository**, name it `party-crm`, choose **Private**, click **Create**.
3. Click **uploading an existing file**, drag in ALL the unzipped files and the `public` folder, then click **Commit changes**.
   (Make sure `server.js`, `package.json`, `render.yaml` and the `public` folder are at the top level of the repository.)

## Step 2 – Put it online with Render
1. Create an account at render.com and sign in with GitHub.
2. Click **New +  >  Blueprint**, pick your `party-crm` repository, click **Apply**.
3. When asked, type your **APP_USER** (your username) and **APP_PASS** (a strong password).
4. Wait a few minutes. Render gives you a web address like `https://party-crm.onrender.com`. Open it and sign in.
5. On your phone: open that address, then "Add to Home Screen" so it works like an app.

## Important: keeping your data safe
The blueprint uses Render's **Starter plan with a 1 GB disk** (a few dollars a month). That disk is what keeps your clients and orders permanently.
On Render's free plan, data is erased on every restart, so please do not use free. Also use **Settings > Download backup** once a week.

## Change currency
Open `public/index.html`, find `const CUR='Rs '` near the top of the script and change it (e.g. `'$'`).

## Run on your computer (optional)
`APP_USER=me APP_PASS=secret npm install && APP_USER=me APP_PASS=secret npm start` then open http://localhost:3000
