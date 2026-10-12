# Ace Fares online booking: setup and testing

The website keeps its own calendar and booking window. A small server, Netlify Functions, holds the bookings and charges renters through **your Stripe account**. Booqable isn't used.

## How a booking works

1. **Blocked dates:** the page asks `/api/availability` which dates are taken, and those days are crossed out in the calendar.
2. **Starting checkout:** the renter presses **Book and pay securely**, and the page sends the car, dates, times and pickup choice to `/api/checkout`. The server:
   - checks the request
   - works out the price itself: rental, then the discount (10% for 3+ days, 25% for 30+ days), then the fee (delivery $100, DFW $125), then Texas rental tax (10% for 30 days or less, 6.25% for 31–180 days)
   - **holds the dates for 35 minutes**
   - creates a Stripe Checkout page and sends the renter there
3. **Payment:** the renter pays on Stripe with whatever methods you turn on in Stripe (Settings → Payment methods), such as card, Apple Pay or Google Pay. Methods that take days to clear, like bank payments, keep the dates held until the money arrives, then confirm or release them.
4. **Confirmation:** Stripe calls `/api/stripe-webhook`, the booking becomes **confirmed**, and the dates stay blocked for good. The renter returns to the site and sees "You're booked!"
5. **Abandoned or declined checkout:** if the renter backs out, the card is declined, or they walk away, the hold is released and the dates open again. Stripe checkout pages expire after 30 minutes.
6. **Turnaround:** there's a 1-day gap between rentals. A car returned on the 10th can go out again on the 11th.
7. **Fallback:** if the server can't be reached, the site falls back to **Text us to book**.

## Files

| Path | What it is |
|---|---|
| `public/` | The website, which is what visitors see |
| `lib/catalog.mjs` | **Prices, fees, discounts and tax that are actually charged.** If you change a price, change it here and in `public/index.html`. A test fails if they don't match. |
| `lib/pricing.mjs`, `lib/bookings.mjs`, `lib/handlers.mjs` | Price math, booking storage (with double-booking protection) and the server routes |
| `netlify/functions/` | Connects the routes to Netlify |
| `tests/` | Automated tests |
| `scripts/live-checks.mjs` | Checks to run against the live site |
| `docs/booqable-notes.md` | Earlier research on Booqable, kept for reference |

## Server routes

| Route | Purpose |
|---|---|
| `GET /api/availability` | Which dates are taken for each car |
| `POST /api/checkout` | Starts a booking and returns the Stripe checkout link |
| `POST /api/cancel` | Renter came back without paying; releases the hold |
| `GET /api/booking?session_id=` | Booking status for the "You're booked!" screen |
| `POST /api/stripe-webhook` | Stripe confirms payment or expiry. The signature is verified on every call. |
| `GET /api/admin/bookings` | All bookings, for you. Needs the `x-admin-key` header. |

## Environment variables

Set these in Netlify under **Site configuration → Environment variables**. Never put them in `index.html` or send them in a chat.

| Name | Where to get it |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys → **Secret key**. Use the **test** key (`sk_test_…`) first. |
| `STRIPE_WEBHOOK_SECRET` | Stripe Dashboard → Developers → Webhooks → your endpoint → **Signing secret** (`whsec_…`). See step 5. |
| `ADMIN_KEY` | Any long password you make up. It's used to view all bookings. |
| `GOOGLE_CLIENT_ID` | Turns on **Continue with Google**. See "Set up Continue with Google" below. It isn't secret. |
| `SESSION_SECRET` (optional) | Signs login cookies. If it's empty, the site makes a random key and keeps it in its private storage. |
| `REQUIRE_ACCOUNT` (optional) | Set to `false` to let people book without an account. Accounts are required by default. |
| `SITE_URL` (optional) | Your custom domain, once you have one. Netlify's own address is used until then. |

Bookings are stored in **Netlify Blobs**, which comes with Netlify. No database to set up.

## Setup steps

1. **Put the code on GitHub:** use the repository `alexbui538-tech/Ace-Fares`.
2. **Connect Netlify:** create a free Netlify account and choose **Add new site → Import from Git**. Pick that repository. The build settings come from `netlify.toml` (publish folder `public`, and the tests run on every deploy).
3. **Add the Stripe secret key:** add `STRIPE_SECRET_KEY` (the test key) and `ADMIN_KEY` in Netlify, then redeploy.
4. **Note the site address:** for example `https://acefares.netlify.app`.
5. **Set up the Stripe webhook:** in Stripe, in **Test mode**, go to Developers → Webhooks → **Add endpoint**.
   - **URL:** `https://YOUR-SITE/api/stripe-webhook`
   - **Events:** `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, the `payment_intent.*` events listed in "On-site checkout page", and the four `identity.verification_session.*` events listed in "Driver's license and selfie check"
   - Copy the signing secret into Netlify as `STRIPE_WEBHOOK_SECRET`, then redeploy.
6. **Run the live tests below.**
7. **Go live:** switch to your **live** Stripe keys. Make a live webhook endpoint (same URL and events) and update both variables in Netlify.

## Tests

### Automated: already run, all passing

- **`npm test`**: 25 server tests, which also run on every Netlify deploy.
  - **Prices:** rentals of 2, 4, 30 and 31 days; delivery and DFW fees; tax brackets.
  - **Checking requests:** past dates, a return before pickup, unknown cars, more than 180 days.
  - **Holds:** they expire, can be released, and a paid booking can't be cancelled.
  - **Turnaround:** the 1-day gap between rentals.
  - **Double booking:** five renters booking the same dates at once, where exactly one wins, repeated over 20 rounds.
  - **Full booking flow:** checkout, then Stripe, then a signed webhook, then confirmed.
  - **Cancelled and expired checkouts:** the dates are released.
  - **Forged webhooks:** rejected.
  - **Stripe down:** a clear error, and the dates aren't left blocked.
  - **Admin key:** required for the bookings list.
  - **Prices on the page:** they match the server's.
  - **No secret keys:** none in the website files.
- **`node tests/site.e2e.mjs`**: 14 browser checks using the real page and real server code, with a stand-in for Stripe.
  - **Calendar:** booked days are blocked.
  - **Price:** the total on the page matches the charge to the cent.
  - **Booking and paying:** shows "You're booked!"
  - **New bookings:** they block the next renter.
  - **Cancelling:** the renter sees "You weren't charged" and the dates are freed.
  - **Server error:** shows a message with a text-us link.
  - **No server:** falls back to "Text us to book".
  - Run it with: `npm i --no-save playwright && npx playwright install chromium && node tests/site.e2e.mjs`

**Not proven yet:** none of this has talked to the real Stripe or real Netlify, because neither was available while building. That's what the live tests are for.

### Live tests (Stripe test mode): required before taking real money

Stripe test cards: `4242 4242 4242 4242` succeeds. `4000 0000 0000 0002` is declined. Use any future expiry date and any CVC.

- [ ] `node scripts/live-checks.mjs https://YOUR-SITE`: availability answers, exactly one of five simultaneous bookings for the same dates succeeds, and past dates are rejected.
- [ ] Book the SRX for 4 days with delivery. The Stripe page shows $212.40 rental (after 10% off), $100 delivery and $31.24 tax. Pay with 4242 and you see "You're booked!"
- [ ] That payment appears in Stripe (test mode) with the car and dates in its description.
- [ ] Those dates now show crossed out for the SRX.
- [ ] `GET /api/admin/bookings` with your admin key shows the booking as `confirmed`, with the renter's name, email and phone.
- [ ] Start a booking and press back on the Stripe page. The site says you weren't charged, and the dates are free.
- [ ] Pay with the declined card 4000 0000 0000 0002. Stripe shows the decline and nothing is booked. The hold is released when the checkout page expires (30 minutes) or when you go back.
- [ ] In Stripe → Webhooks → your endpoint, deliveries show `200`.

## Refunds and cancellations

Refund from the Stripe Dashboard, under Payments → the payment → Refund. Refunding doesn't free the dates automatically yet, so tell me if you want that added. If a booking is ever marked `conflict` (paid after the hold had expired while someone else booked the same dates, which should be very rare), refund it in Stripe.

## Taxes

The site charges Texas motor vehicle rental tax (10% for 30 days or less, 6.25% for 31–180 days) on the rental after discounts, plus delivery and airport fees. Confirm with your accountant whether those fees should be taxed. The setting is `TAX_INCLUDES_FEES` in `lib/catalog.mjs`, and the matching `includesFees` in `public/index.html`. You're responsible for filing and remitting the tax collected. Stripe doesn't do that for you.

## Your bookings page

Open **https://acefaresrental.netlify.app/admin.html** and sign in with your `ADMIN_KEY`. It shows each car's upcoming paid bookings: dates, times, renter name, phone and email, pickup or delivery, and amount paid. **Cancel** frees the dates. If the renter paid, refund them in the Stripe Dashboard as well. The page isn't linked from the website and tells search engines not to list it, but treat the admin key like a password.

## Prices

| Car | Mon–Thu | Fri–Sun |
|---|---|---|
| Cadillac Escalade | $259 | $349 |
| Cadillac SRX | $49 | $69 |
| BMW 650i Convertible | $139 | $199 |
| Honda Odyssey | $59 | $59 |

Each rental day is priced by its day of the week. The return day isn't charged, so a Thursday pickup with a Monday return is one weekday plus three weekend days. Discounts and tax apply to the total. To change prices, edit `lib/catalog.mjs` **and** the matching `weekday`/`weekend` numbers in `public/index.html`. The tests fail if they don't match.

## Confirmation email and rental agreement

After every paid booking, the renter automatically gets an email from your Gmail with the booking details and the **full rental agreement**, filled in with their name and trip. You get a copy if `OWNER_EMAIL` is set. The agreement is also at **/rental-agreement**. Its wording lives in `lib/agreement.mjs`.

**The agreement is a draft template, not legal advice.** Fill in the `POLICY` values: extra-mile rate, late fee, fuel fee, cleaning fee, ticket fee, cancellation policy, and whether out-of-state driving is allowed. The smoking fee ($150) and the deposits are already set in `lib/catalog.mjs`. Until they're filled in, they show as "[to be set]" and the page says "Draft". Have a Texas attorney review it before relying on it.

**Turn on the email:**
1. Your Google account (acefaresrental@gmail.com) needs **2-Step Verification** on: myaccount.google.com → Security.
2. Create an **App password** at myaccount.google.com/apppasswords and copy the 16-character password.
3. In Netlify, add `GMAIL_USER` = `acefaresrental@gmail.com`, `GMAIL_APP_PASSWORD` = the app password, and optionally `OWNER_EMAIL`. Then redeploy.

If an email ever fails, the booking still goes through, and the failure is saved on the booking (`emailError`).

**Turn on the "I agree" box at checkout:**
1. In Stripe, go to **Settings → Public details** (dashboard.stripe.com/settings/public) and set **Terms of service** to `https://acefaresrental.netlify.app/rental-agreement`.
2. In Netlify, add `REQUIRE_TERMS` = `true`, then redeploy.

Renters then must tick "I have read and agree to the Ace Fares Rental Agreement" before paying, and each booking records `termsAccepted: true`.

## On-site checkout page (like Turo's)

After **Book and pay securely**, renters go to the site's own checkout page, `/checkout.html`. It has their details, Stripe's secure payment form, and an "I agree" box on the left, and a trip summary on the right with the car photo, dates, pickup spot, price breakdown, miles included and total. Card numbers are typed into Stripe's secure fields and never reach Ace Fares' server.

- **Dates are held while they pay.** A countdown shows the 35-minute hold. If it runs out, pressing Book trip still works as long as nobody else has taken the dates.
- **Declined card:** the renter sees Stripe's message and can try again. The dates stay held.
- **Change trip** releases the dates and cancels the payment.
- **Payment methods** are whatever you turn on in Stripe (Settings → Payment methods): card, Google Pay, Apple Pay, and any pay-later options Stripe approves for your business.

**To turn it on:**
1. In Netlify, add `STRIPE_PUBLISHABLE_KEY`. Copy it from Stripe → Developers → API keys → **Publishable key**: `pk_test_…` while testing, `pk_live_…` when live. Then go to Deploys → Trigger deploy.
2. In Stripe → Developers → Webhooks → your endpoint, add these events: `payment_intent.succeeded`, `payment_intent.processing`, `payment_intent.payment_failed`, `payment_intent.canceled`.
3. For Apple Pay and Google Pay, go to Stripe → Settings → Payment method domains and add `acefaresrental.netlify.app`, plus your own domain later.

Until step 1 is done, Book and pay securely keeps using Stripe's hosted payment page, so nothing breaks in the meantime.

**The publishable key must match the secret key:** `pk_test_` goes with `sk_test_`, and `pk_live_` goes with `sk_live_`. If they don't match, the site logs a warning and keeps using Stripe's hosted payment page instead of showing a broken form. When you go live, switch both keys, and the webhook secret, at the same time.

Routes: `GET /api/checkout-details?car=&ref=` returns the trip summary and starts the payment form. `POST /api/checkout-details` saves the renter's name, email, phone and agreement, and refreshes the hold, right before paying.

## Electronic signature (clickwrap), deposit hold and no-smoking policy

The full text, code and the questions for your attorney are in **`docs/TERMS-CLICKWRAP.md`**.

- **Signing:** the checkout page shows a "Key rental terms" box and the signature checkbox. **Book trip stays disabled until the box is checked.** When the renter pays, the server records the signing time, their IP address, browser, agreement version and a SHA-256 fingerprint of the exact text. It saves that record on the Stripe payment (Payments → the payment → Metadata: `contract_signed`, `contract_signed_at`, `signer_ip`, `contract_sha256`, `deposit_policy_ack`, `smoking_policy_ack` and more), on the booking, and as a full signed copy. The renter's email includes a "Signature record".
- **Deposit hold:** Escalade $750, BMW $500, SRX $250 and Odyssey $250 (change these in `lib/catalog.mjs`). The card is saved at checkout. The hold goes on automatically 24 hours before pickup, or right after payment if pickup is sooner, and is released automatically 72 hours after return. Long rentals get the hold renewed before it expires.
- **On your bookings page,** each booking shows its hold and the buttons **Collect…** (enter an amount and a reason, e.g. $150 smoking fee; the rest is released), **Release**, **Keep hold** (stops the automatic release while you check for damage) and **Try again**. If a hold fails, you get an email, if Gmail is set up.
- **Stripe webhook:** no new events are needed. Deposit holds use the `payment_intent.*` events you already added, and they never change the rental booking itself.
- **Holds longer than 7 days** need Stripe's *extended authorization*. It's included on IC+ pricing; on standard pricing, ask Stripe support to turn it on for vehicle rental. Without it, the site simply renews the hold every 7 days or so.
- **The hourly job** (`deposit-holds`) appears in Netlify → Functions as a scheduled function. Scheduled functions only run on the live (published) site.

Tests: `node tests/checkout.e2e.mjs` runs browser checks: opening the page, the totals match, required fields, paying, the confirmation and email, a declined card, Change trip, a blocked payment form, and a dead link.

## Renter accounts: log in / sign up (email or Google)

Like Turo, renters sign in before they book. Clicking **Book and pay securely** while logged out opens a **Log in to book** window, and booking continues on its own once they're in. The header shows **Log in / Sign up**, or the renter's initials with a menu: **My trips**, **Book a car**, **Log out**.

- **Email first:** the renter types their email. If an account exists they enter their password; if not, they get the sign-up form (first and last name as on their license, optional mobile number, password of 8+ characters).
- **Continue with Google:** one tap, once `GOOGLE_CLIENT_ID` is set (steps below). If someone had already signed up with that email using a password nobody verified, Google sign-in takes over the account and removes that password.
- **Forgot password:** emails a one-time link that works for 60 minutes. This needs Gmail set up (`GMAIL_USER` and `GMAIL_APP_PASSWORD`). Without it, renters are told to text you.
- **Checkout is filled in** with the renter's name, email and phone, and a trip can only be paid for from the account that booked it.
- **My trips** lists each booking with its status and the license check. It has a **Verify your license** button until the check is done.
- **Security:**
  - Passwords are stored only as scrypt hashes.
  - Logins are a signed, HttpOnly cookie that lasts 30 days.
  - After 8 wrong passwords, that email is locked for 15 minutes.
  - Requests from other websites are refused.
  - Accounts live in a private Netlify Blobs store called `users`.

### Set up "Continue with Google" (free, about 10 minutes)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in with the business Google account. Create a project, for example "Ace Fares Website".
2. Open **Google Auth Platform**, which may be labeled **APIs & Services → OAuth consent screen**.
   - Choose **External** and fill in the app name "Ace Fares Rental", the support email and your logo.
   - Under **Audience**, press **Publish app** so anyone can sign in, not just test users. This site only asks Google for name, email and photo, which don't need Google's review.
3. Go to **Clients** (or **Credentials → Create credentials → OAuth client ID**) and choose **Web application**.
   - Under **Authorized JavaScript origins**, add `https://acefaresrental.netlify.app`, plus your own domain later.
   - Don't add a client secret anywhere. This sign-in method doesn't use one.
4. Copy the **Client ID**, which ends in `.apps.googleusercontent.com`. Add it in Netlify as `GOOGLE_CLIENT_ID`, then redeploy. The Google button appears in the sign-in window.

## Driver's license and selfie check (Stripe Identity)

After paying, the confirmation shows **Verify your license now**. It also appears in My trips and in the email link. It opens `/verify.html`, which works like this:

1. **Two boxes** explain the steps: **1. Your driver's license** (front and back, from the camera, photo library or a file) and **2. A selfie**.
2. **Texas biometric consent:** the renter must check a box before starting. This is required by Tex. Bus. & Com. Code §503.001. The consent records the time, IP address and version.
3. **Start verification** opens Stripe's secure screens:
   - Stripe checks that the license is genuine.
   - It compares the selfie with the license photo.
   - Photos go straight to Stripe, never through your site.
4. **The result** comes back automatically through the webhook. The site then checks it against the booking:
   - The renter is **21 or older on the pickup date**.
   - The **name matches** the booking or the account.
   - The **license is valid through the return date**.
   - If everything passes, the booking shows **Verified**. If anything fails, it shows **Needs your review** and you're emailed.
   - The site never stores the license photos, the date of birth or the license number. It keeps only the result and the name on the license.
5. **Deletion:** the hourly job tells Stripe to permanently delete (redact) the license images and face data **90 days after the return**, or 30 days after a cancellation. That's well inside Texas's one-year limit.
6. **Your bookings page** has a **License check** column with each renter's status, the reasons for any review, and a link to the check in Stripe.

**Cost:** $1.50 per completed check (Stripe Identity, US pricing). The first 50 are free.

**Setup:**
1. **Turn it on:** in the Stripe Dashboard, open **Identity** (search "Identity") and complete the short activation form. Test mode works right away; live mode needs Stripe's approval.
2. **Webhook events:** in **Developers → Webhooks →** your endpoint, add these four events:
   - `identity.verification_session.verified`
   - `identity.verification_session.requires_input`
   - `identity.verification_session.processing`
   - `identity.verification_session.canceled`
3. **Branding (optional):** under **Settings → Branding**, add your logo and colors. Stripe's ID screens use them.

**About the Texas DMV:** Texas driver's licenses are kept by **Texas DPS**, not the DMV, and there's no public database a business can search. The closest thing is AAMVA's DLDV service. It only confirms that the name, date of birth, license number and expiration match state records, and it doesn't compare photos. It's sold only through approved identity companies such as Persona, Incode or Onfido, usually under a sales contract. If you want that later, it can be added next to the Stripe check.
