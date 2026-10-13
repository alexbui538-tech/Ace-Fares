# Ace Fares website: launch checklist (audit of October 12, 2026)

## Fixed during the audit (live)
- Checkout now asks for the **delivery address** (required for Delivery) and an optional **flight number** (DFW). Both are saved to the booking, Stripe, the New booking email and the bookings page.
- The Stripe webhook no longer shows server error details to the public when it isn't set up.
- Security headers added. The bookings page is hidden from search engines.
- Added robots.txt and sitemap.xml, plus a share image and preview text for links posted on social media and in texts.
- The You're booked screen no longer has an "I'll do it later" option for the license check.

## Done
- ✅ **Stripe webhook (test mode)** set up with 12 events, and `STRIPE_WEBHOOK_SECRET` added in Netlify. Confirmed on October 12: the site rejects messages with a fake signature.
- ✅ **Rental terms filled in** (agreement draft8): $3/extra mile, $50 late fee after a 30-minute grace period, $30 fuel fee plus fuel, $30 cleaning, a $20 cancellation fee after 24 hours, no out-of-state travel, tolls and tickets at cost plus a $15 handling fee each, extensions at the daily rate plus $25/day.
- ✅ **Built October 13:** renter cancellation with automatic refunds, trip extensions (owner approves; on/off switch), post-trip charges with itemized statements, reviews (emailed after each trip, shown on the site), and the Become a host form now emails your inbox.
- ✅ **Gmail connected** (`GMAIL_USER`, `GMAIL_APP_PASSWORD`, `OWNER_EMAIL`). The site sees the settings. Confirm with a test booking that the emails actually arrive.

## Must do before taking real bookings (needs you)
1. **Turn on Stripe Identity** in Stripe (search "Identity"). Test mode works right away; live mode needs Stripe's approval.
2. **Toll tags:** put an NTTA TollTag on each car, under your account, so tolls are billed to you at the lower tag rate. After each trip, charge the tolls from the bookings page (Add charge → Tolls); the $15 handling fee per toll is added automatically. For mailed toll bills, send the toll authority the signed rental agreement within 30 days of the bill.
3. **Insurance:** written confirmation that your commercial or fleet policy covers paid rentals, drivers aged 18–20, and rideshare/delivery use.
4. **Texas motor vehicle rental tax:** the site charges 10% (6.25% for 31+ days). Make sure you have the Comptroller permit and are filing it. Confirm with an accountant.
5. **Attorney review:** rental agreement draft8, privacy policy, referral terms, biometric consent, minimum age 18.
6. **Go live:**
   - Switch Netlify to the live Stripe keys and add a live webhook with the same 12 events.
   - Make one real booking, then refund it.

## Recommended features (Claude can build)
- **Blocking dates on the bookings page** for maintenance or personal use. Needs: nothing.
- **Date changes** (moving a trip, not just extending it) from My trips. Needs: nothing.
- **Additional drivers**, each with their own license check. Needs: a fee, if any.
- **Editing prices and deposits from the bookings page** instead of in code. Needs: nothing.
- **Contact form** that arrives in your inbox. Needs: nothing.
- **Google sign-in.** Needs: a Google Client ID.
- **Booking texts to (972) 994-6413.** Needs: a Twilio account.
- **The Roamly option at checkout.** Needs: your Roamly link.
- **Custom domain** (e.g. acefaresrental.com). Needs: buy the domain. Netlify, Stripe and Google settings follow.
- **Visitor stats** (Google Analytics / Meta Pixel). Needs: the tracking IDs.
- **Confirm** the delivery service areas and every FAQ answer, which are marked TODO in the code.
