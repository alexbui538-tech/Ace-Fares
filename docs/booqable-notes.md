# Booqable integration: Ace Fares

Last updated: Oct 11, 2026

## 1. What the codebase is today

| Item | Finding |
|---|---|
| Framework | None. One static `index.html` (HTML, CSS and plain JavaScript in one file) plus an `images/` folder. No build step, no `package.json`. |
| Routing | Single page. Sections are anchors (`#fleet`, `#how`, `#delivery`, `#faq`). `#host` switches to the Become a host view with a small hash router (`route()`). |
| Data | The cars, prices, locations, discounts and FAQ are hard-coded in the `SITE`, `CARS` and `FAQ` objects at the top of the script. |
| Backend | None. |
| Deployment | Not deployed. The site exists as local files and a private preview. |
| Secrets in code | None. The Booqable script URL in `SITE.booqableScript` is a public asset URL, not a credential. |

## 2. Embed or API? Recommendation: embed now, API later only if needed

**Use Booqable's official embedded components for booking and checkout.** Keep the Ace Fares design for everything else.

Why:

1. **There's no public or storefront checkout API.** Booqable's v4 API docs say access tokens "carry many privileges" and must not be used in client-side code. They document no storefront key and no hosted checkout resource. A custom checkout would need its own server that holds an admin-level token and rebuilds the order, booking, pricing and payment flow. That's a lot of risk for a four-car fleet.
2. **The v4 API is labeled beta.** The docs warn that "we might introduce non-backwards compatible changes."
3. **The embedded product button already covers the required flow:** date choice, live availability, pricing, cart and checkout. Payment runs through your Stripe account connected inside Booqable. Inventory and reservations stay in sync automatically because the booking is created in Booqable itself.
4. **The site has no backend yet.** Adding one means picking a host and paying to maintain it before the first booking.

**When the API would be worth it:** if you later want your own calendar to grey out booked dates before a renter opens checkout, or to load the cars from Booqable instead of the `CARS` list. That needs a small server (section 6).

## 3. What Booqable supports (from the official docs)

| Need | Supported? | How / source |
|---|---|---|
| Show cars, photos, descriptions, prices | Yes | Kept in the Ace Fares design (`CARS`). The API also has products, photos and price structures. |
| Renter picks dates, sees availability | Yes | Embedded product button and `booqable-datepicker` component. The API has `GET /api/4/availabilities` (filters: `subject_type`, `subject_id`, `year`, `month`). |
| Booking and checkout | Yes, through the embed | Booqable's own cart and checkout. The API documents no hosted-checkout resource. |
| Payments through Stripe | Yes | Settings > Payment providers > Connect with Stripe. Checkout can charge in full, take a down payment, or take a security deposit. |
| Reservations synced | Yes | Bookings made through the embed are created in Booqable directly. |
| Discounts (10% at 3+ days, 25% at 30+ days) | **Must be set in Booqable** | The website shows them, but Booqable's checkout charges whatever its own price structure says. Set them up in Booqable's pricing settings, or renters will be charged full price. |
| Create orders, book products, charge payments through the API | Listed, not verified | The docs index lists Orders, Order fulfillments (book), and Payment charges (modes include `request` and `off_session`). The detailed payloads I found came from a third-party copy of the docs, not Booqable's own pages, so they need checking against developers.booqable.com before anything is built on them. |

## 4. Turo-style marketplace: what Booqable does NOT provide

Nothing in Booqable's docs, help center or Stripe integration pages mentions any of these:

| Marketplace need | Booqable |
|---|---|
| Third-party owners signing up and managing their own cars | Not documented. Booqable is software for one rental business, with employees and users, not independent sellers. |
| Owner-specific payouts | Not documented. Booqable connects one Stripe account to your company. |
| Marketplace commissions or split payments | Not documented. No Stripe Connect, multiple payees or split payments are mentioned. |
| Per-trip insurance, driver verification, trip photo check-in/out, damage claims | Not documented as built-in rental workflows. Booqable offers security deposits and card authorizations only. |

**What this means:**

- **Now:** Booqable works for the cars you own or manage directly. If outside owners join, you could list their cars as your own products and pay owners yourself outside Booqable, as a managed or consignment arrangement. Before doing that, talk to an insurance agent and an accountant about commercial rental insurance and 1099 reporting.
- **True marketplace:** owners onboarding themselves and automatic split payouts need a platform built for that. One option is Stripe Connect (Express accounts with an application fee) behind a custom backend. Another is marketplace software such as Sharetribe. Booqable could still be the inventory tool for your own fleet alongside it, but it can't run the marketplace.

*This isn't legal, tax or insurance advice.*

## 5. What's implemented now (Phase 1: embedded)

All of this is in `index.html`. The design hasn't changed.

- **Install script:** `SITE.booqableScript` holds your install script URL. **The script only loads once at least one car has a `booqableId`,** so the site behaves exactly as before until you add one.
- **Product IDs:** each car in `CARS` has `booqableId: ""`. Paste the `data-id` value from that product's embed code, for example `booqableId: "cadillac-escalade"`.
- **Booking window for a Booqable car:**
  - Ace Fares' own date, time and delivery fields and its estimate are hidden.
  - Booqable's datepicker and that car's product button are shown, so Booqable handles dates, availability, price, cart and checkout.
  - The discount tiles stay visible.
- **Loading state:** "Loading live availability..." shows until Booqable draws its button.
- **Error and fallback:** if the script fails to load, or Booqable hasn't drawn the button within 12 seconds, the window switches back to Ace Fares' own fields with "Text us to book" and a short notice. Renters are never stuck.
- **Cars without a `booqableId`:** these keep the "Text us to book" flow.
- **Unavailable dates and failed checkouts:** these happen inside Booqable's checkout, which shows its own messages. The site can't see or change them.

## 6. Phase 2 (optional, not built): server routes for live availability

Only build this if you want Ace Fares' own calendar to show booked dates. It needs a host with serverless functions, such as Netlify Functions or Cloudflare Workers.

**Environment variables (server only, never in `index.html`):**

| Variable | Value |
|---|---|
| `BOOQABLE_COMPANY_SLUG` | Your company slug: the part before `.booqable.com` in your Booqable admin address |
| `BOOQABLE_ACCESS_TOKEN` | A **new** token. Delete the one pasted in chat. |
| `BOOQABLE_WEBHOOK_SECRET` | Used to verify v4 webhooks, if webhooks are enabled |

**Routes:**

| Route | Calls | Notes |
|---|---|---|
| `GET /api/availability?car=escalade&year=2026&month=11` | `GET https://{slug}.booqable.com/api/4/availabilities?filter[subject_type]=item&filter[subject_id]={product uuid}&filter[year]=..&filter[month]=..` with `Authorization: Bearer $BOOQABLE_ACCESS_TOKEN` | Returns only dates and status. Cache for about 5 minutes. Needs the product **UUID**, not the slug. Check that `item` is the right `subject_type` for products. |
| `GET /api/vehicles` | `GET /api/4/products` plus photos | Optional. Only needed to stop maintaining `CARS` by hand. |
| `POST /api/webhooks/booqable` | (incoming) | Optional. Use it to clear the availability cache when an order changes. Follow the "Verifying v4 webhooks" section of the docs. |

Checkout would still go through the embed. A custom API checkout (orders, then order fulfillments with `book_product`, then payment charges) isn't recommended until those endpoints are verified against the official docs and tested on a test account.

## 7. Setup steps

1. In Booqable, connect Stripe: Settings > Payment providers > Connect with Stripe.
2. Choose what checkout collects: Settings > Checkout > Payments in checkout. Pick full payment, a down payment or a deposit.
3. Create one product per car with the correct daily price and a quantity of 1.
4. Set the 3+ day (10%) and 30+ day (25%) discounts in Booqable's pricing settings.
5. Make each product visible in the online store, then copy the `data-id` from its product button embed code.
6. Paste each `data-id` into that car's `booqableId` in `index.html`.
7. Put the site online at its real address. Booqable may only work on a live domain.
8. Run the live checklist below.
9. **Security:** delete the API access token that was pasted in chat. Phase 1 doesn't need a token at all.

## 8. Tests

### Automated (run, all passing)

`tests/booqable-embed.test.js` runs the page in a headless browser with a stand-in for Booqable's script. It checks four cases:

1. No product IDs: the Booqable script isn't loaded, and "Text us to book" shows.
2. Booqable loads: the loading message appears and then clears, the Escalade shows the Booqable button, the site's own fields and checkout button hide, and the SRX (no ID) keeps the text flow.
3. The script fails to load: the window falls back to the site's own fields and "Text us to book".
4. The script loads but never draws: after 12 seconds the window falls back and shows a notice, and the window stays open.

19 of 19 checks pass, with no page errors.

**Limits of these tests:** they prove the website's own logic only. They do **not** prove that Booqable's real script, availability or checkout works with this page. The test environment can't reach Booqable.

To run them: `npm i -D playwright`, then `node tests/booqable-embed.test.js` from the website folder.

### Live checklist (needed before calling it working)

- [ ] The live site loads Booqable's script without console errors.
- [ ] Each car's booking window shows Booqable's button with the right car and price.
- [ ] Choosing dates already booked in Booqable shows them as unavailable.
- [ ] A 4-day trip shows 10% off at checkout, and a 30-day trip shows 25% off.
- [ ] A test booking completes, appears in Booqable as an order, and blocks those dates.
- [ ] The Stripe payment, down payment or deposit appears in Stripe.
- [ ] A declined test card shows an error and creates no confirmed booking.
- [ ] With Booqable blocked (for example by an ad blocker), the site falls back to "Text us to book".

## Sources

- Booqable API v4 docs: https://developers.booqable.com
- Embedding products: https://help.booqable.com/en/articles/1826851
- Embeddable components: https://help.booqable.com/en/articles/4163445-embeddable-components
- Stripe in Booqable: https://help.booqable.com/articles/606610-stripe
- Payment methods and checkout payments: https://help.booqable.com/en/articles/1664955-the-different-payment-methods-of-booqable
- Third-party copy of the API docs, used only for payload details and needing verification: https://www.withone.ai/knowledge/booqable
