# Ace Fares website: launch checklist (audit of October 12, 2026)

## Fixed during the audit (live)
- Checkout now asks for the **delivery address** (required for Delivery) and an optional **flight number** (DFW). Both are saved to the booking, Stripe, the New booking email and the bookings page.
- The Stripe webhook no longer shows server error details to the public when it isn't set up.
- Security headers added. The bookings page is hidden from search engines.
- Added robots.txt and sitemap.xml, plus a share image and preview text for links posted on social media and in texts.
- The You're booked screen no longer has an "I'll do it later" option for the license check.

## Done
- ✅ **Stripe webhook (test mode)** set up with 12 events, and `STRIPE_WEBHOOK_SECRET` added in Netlify. Confirmed on October 12: the site rejects messages with a fake signature.
- ✅ **Gmail connected** (`GMAIL_USER`, `GMAIL_APP_PASSWORD`, `OWNER_EMAIL`). The site sees the settings. Confirm with a test booking that the emails actually arrive.

## Must do before taking real bookings (needs you)
1. **Turn on Stripe Identity** in Stripe (search "Identity"). Test mode works right away; live mode needs Stripe's approval.
2. **Fill in the 7 blanks in the rental agreement:** extra-mile rate, late fee and grace period, fuel service fee, cleaning fee, toll/ticket admin fee, cancellation policy, and whether out-of-state travel is allowed.
3. **Insurance:** written confirmation that your commercial or fleet policy covers paid rentals, drivers aged 18–20, and rideshare/delivery use.
4. **Texas motor vehicle rental tax:** the site charges 10% (6.25% for 31+ days). Make sure you have the Comptroller permit and are filing it. Confirm with an accountant.
5. **Attorney review:** rental agreement draft6, privacy policy, referral terms, biometric consent, minimum age 18.
6. **Go live:**
   - Switch Netlify to the live Stripe keys and add a live webhook with the same 12 events.
   - Make one real booking, then refund it.

## Recommended features (Claude can build)
- **Renter cancellation with automatic refunds** by your policy. Needs: your cancellation policy.
- **Blocking dates on the bookings page** for maintenance or personal use. Needs: nothing.
- **Post-trip charges to the saved card** with an itemized statement (extra miles, fuel, late return, tolls, cleaning). Needs: the fee amounts.
- **Trip extensions and changes** from My trips. Needs: nothing.
- **Additional drivers**, each with their own license check. Needs: a fee, if any.
- **Editing prices and deposits from the bookings page** instead of in code. Needs: nothing.
- **Reviews after the trip**, emailed to the renter and shown on the site. Needs: approval.
- **Become a host and contact forms** that arrive in your inbox instead of opening the visitor's email app. Needs: nothing (Gmail is now connected).
- **Google sign-in.** Needs: a Google Client ID.
- **Booking texts to (972) 994-6413.** Needs: a Twilio account.
- **The Roamly option at checkout.** Needs: your Roamly link.
- **Custom domain** (e.g. acefaresrental.com). Needs: buy the domain. Netlify, Stripe and Google settings follow.
- **Visitor stats** (Google Analytics / Meta Pixel). Needs: the tracking IDs.
- **Confirm** the delivery service areas and every FAQ answer, which are marked TODO in the code.
