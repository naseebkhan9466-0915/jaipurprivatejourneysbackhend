# Jaipur Private Journeys - Website + Review Backend

Customer review likhta hai -> aapko email aata hai -> aap "Approve" dabate ho -> review sabko website par dikhta hai.

## Kaise chalta hai
1. Customer website par "Post Review" dabata hai (photos ke saath bhi).
2. Review "pending" mein save hota hai (abhi kisi ko nahi dikhta) aur aapke email par aata hai.
3. Email mein **Approve** aur **Reject** button hain. Dabane par ek confirm page khulta hai, wahan ek baar aur dabana hai.
4. Approve hote hi review website ke Reviews page aur home page ke slider mein sabko dikhta hai.
5. Baad mein koi review hatana ho to usi email ka **Reject** link khol lo.

## Chalane ke steps
1. Computer/server par Node.js (version 18 ya naya) install karein.
2. Is folder mein `npm install` chalayein.
3. `.env.example` ko `.env` naam se copy karke apni values bharein (ya hosting ke "Environment Variables" mein daalein).
4. `npm start` chalayein. Website `http://localhost:3000` par khulegi.

## Gmail se email bhejne ke liye
- Google account mein 2-Step Verification ON karein.
- Google Account > Security > "App passwords" se ek App Password banayein.
- Wahi `SMTP_PASS` mein daalein (`SMTP_USER` aapka Gmail, `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`).

## Hosting par daalte waqt dhyan dein
- Server (Node.js) chalane wali hosting chahiye: VPS (DigitalOcean, Hostinger VPS, etc.) ya Render / Railway jaisi service.
- **Reviews aur photos ek file/folder mein save hote hain (`DATA_DIR`).** Hosting par is folder ke liye **persistent disk / volume** zaroor lagayein aur `DATA_DIR` usi ke path par rakhein. Warna kai free plans par restart/redeploy hone par saare reviews mit jaate hain.
- `BASE_URL` mein website ka asli https link daalein, warna email ke Approve/Reject links galat bante hain.
- Kuch hosting par free plan thodi der baad "so jaata" hai, to pehla review aane mein der lag sakti hai.

## Files
- `server.js` - poora backend
- `public/index.html` - website (reviews ab server se judi hui hain)
- `.env.example` - settings ka namuna
