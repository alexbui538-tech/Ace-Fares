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
| `SITE_URL` (optional) | Your custom domain, once you have one. Netlify's own address is used until then. |

Bookings are stored in **Netlify Blobs**, which comes with Netlify. No database to set up.

## Setup steps

1. **Put the code on GitHub:** use the repository `alexbui538-tech/Ace-Fares`.
2. **Connect Netlify:** create a free Netlify account and choose **Add new site → Import from Git**. Pick that repository. The build settings come from `netlify.toml` (publish folder `public`, and the tests run on every deploy).
3. **Add the Stripe secret key:** add `STRIPE_SECRET_KEY` (the test key) and `ADMIN_KEY` in Netlify, then redeploy.
4. **Note the site address:** for example `https://acefares.netlify.app`.
5. **Set up the Stripe webhook:** in Stripe, in **Test mode**, go to Developers → Webhooks → **Add endpoint**.
   - **URL:** `https://YOUR-SITE/api/stripe-webhook`
   - **Events:** `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`
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

**The agreement is a draft template, not legal advice.** Fill in the `POLICY` values: extra-mile rate, late fee, fuel fee, cleaning and smoking fees, ticket fee, cancellation policy, and whether out-of-state driving is allowed. Until they're filled in, they show as "[to be set]" and the page says "Draft". Have a Texas attorney review it before relying on it.

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

Tests: `node tests/checkout.e2e.mjs` runs 23 browser checks: opening the page, the totals match, required fields, paying, the confirmation and email, a declined card, Change trip, a blocked payment form, and a dead link.
