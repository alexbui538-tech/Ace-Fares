# Ace Fares website: launch checklist (audits of October 12 and 13, 2026)

## Fixed during the audit (live)
- Checkout now asks for the **delivery address** (required for Delivery) and an optional **flight number** (DFW, since removed). Both are saved to the booking, Stripe, the New booking email and the bookings page.
- The Stripe webhook no longer shows server error details to the public when it isn't set up.
- Security headers added. The bookings page is hidden from search engines.
- Added robots.txt and sitemap.xml, plus a share image and preview text for links posted on social media and in texts.
- The You're booked screen no longer has an "I'll do it later" option for the license check.

## Second audit (October 13, late evening), live site
- Every page loads on the live site, and on a phone none of them scroll sideways or show script errors.
- Private routes refuse access without a login or the admin key: bookings, charges, trip changes, ID check, photos. The Stripe webhook refuses messages without Stripe's signature.
- A test booking reached the payment form, with Stripe in test mode. The test holds were released afterwards.
- Fixed: the ID check showed a blank white screen on phones. Phones now use Stripe's full-screen page.
- Fixed: the rental agreement page now sends the same security headers as the other pages, and the review page is hidden from search engines.
- 92 automated checks and 3 browser test suites pass.

## Done
- ✅ **Built October 13 (late):** blocked dates, pickup and return-day reminder emails, a refund choice when you cancel, payment links for declined charges, the monthly sales and tax report, vehicle records with service reminders, pickup vs. return photo comparison, date changes from My trips, price and deposit editing, booking export and backup, and the contact form. Rental agreement draft9 (date changes, section 15).
- ✅ **Stripe webhook (test mode)** set up with 12 events, and `STRIPE_WEBHOOK_SECRET` added in Netlify. Confirmed on October 12: the site rejects messages with a fake signature.
- ✅ **Rental terms filled in** (agreement draft10): extra miles $3/mile for the Escalade and $0.99/mile for the other cars, $50 late fee after a 30-minute grace period, $30 fuel fee plus fuel, $30 cleaning, a $20 cancellation fee after 24 hours, no out-of-state travel, tolls and tickets at cost plus a $15 handling fee each, extensions at the daily rate plus $25/day.
- ✅ **Built October 13:** renter cancellation with automatic refunds, trip extensions (owner approves; on/off switch), post-trip charges with itemized statements, reviews (emailed after each trip, shown on the site), and the Become a host form now emails your inbox.
- ✅ **Gmail connected** (`GMAIL_USER`, `GMAIL_APP_PASSWORD`, `OWNER_EMAIL`). The site sees the settings. Confirm with a test booking that the emails actually arrive.

## Must do before taking real bookings (needs you)
1. **Turn on Stripe Identity** in Stripe (search "Identity"). Test mode works right away; live mode needs Stripe's approval.
2. **Toll tags:** put an NTTA TollTag on each car, under your account, so tolls are billed to you at the lower tag rate. After each trip, charge the tolls from the bookings page (Add charge → Tolls); the $15 handling fee per toll is added automatically. For mailed toll bills, send the toll authority the signed rental agreement within 30 days of the bill.
3. **Insurance:** written confirmation that your commercial or fleet policy covers paid rentals, drivers aged 18–20, and rideshare/delivery use.
4. **Texas motor vehicle rental tax:** the site charges 10% (6.25% for 31+ days). Make sure you have the Comptroller permit and are filing it. Confirm with an accountant.
5. **Attorney review:** rental agreement draft11 (and the Wheelbase version), privacy policy, referral terms, biometric consent, minimum age 18.
6. **Go live:**
   - Switch Netlify to the live Stripe keys and add a live webhook with the same 12 events.
   - Make one real booking, then refund it.

7. **Stripe settings:** under Settings → Business → Public details, set the statement descriptor (e.g. ACE FARES RENTAL) and the support phone and email that renters see on their card statements and receipts. Under Settings → Customer emails, turn on successful-payment and refund receipts.
8. **Confirm the emails arrive:** after a test booking, check that you got the "New booking" email and the renter got the confirmation with the agreement. Check spam too.
9. **Business listings:** create a Google Business Profile for Ace Fares with the website link. This drives most local "car rental near me" searches.

## Recommended features (Claude can build)
### Needs nothing from you
- **Stronger owner sign-in:** your own email and password with a code, instead of the shared admin key.

### Needs a decision or an account from you
- **Additional drivers**, each with their own license check. Needs: a fee per driver, if any.
- **Promo codes** (e.g. FIRSTRIDE10). Needs: the codes and amounts you want.
- **Under-25 young driver fee.** Needs: the amount, if any. Many companies charge $15-$30 a day for drivers under 25.
- **Delivery fee by distance** instead of a flat $100. Needs: a Google Maps API key and your pricing per mile.
- **Google sign-in.** Needs: a Google Client ID.
- **Booking texts to (972) 994-6413.** Needs: a Twilio account.
- **The Roamly option at checkout.** Needs: your Roamly link.
- **Custom domain: acefares.com.** DNS points to Netlify, and the site uses acefares.com for Google. Still to do: set `SITE_URL`, move the Stripe webhook to acefares.com, and add the domain in Google Search Console (see SETUP.md).
- **Visitor stats** (Google Analytics / Meta Pixel). Needs: the tracking IDs.
- **Confirm** the delivery service areas and every FAQ answer, which are marked TODO in the code.
