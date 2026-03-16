npm init -y
npm install -D wrangler
npx wrangler login
npx wrangler secret put SIGNAL_SHARED_SECRET
npx wrangler deploy
