# Kikoo – free setup
1. Neon (free database): neon.tech > sign up > create project > copy the Connection string (starts with postgresql://).
2. GitHub: upload these files (server.js, package.json, render.yaml, README.md, public/index.html).
3. Render: New > Web Service > pick the repo. Runtime Node, Build `npm install`, Start `npm start`, Instance type Free.
   Environment variables: APP_USER, APP_PASS, SESSION_SECRET (any long text), DATABASE_URL (the Neon string).
Note: on Render Free the app sleeps after ~15 min idle; the first visit then takes about a minute to wake up.
Currency: change `const CUR='Rs '` in public/index.html.
