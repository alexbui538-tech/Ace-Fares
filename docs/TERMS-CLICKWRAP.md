# Ace Fares: clickwrap signature, deposit hold and smoking policy

**Status: DRAFT FOR TEXAS ATTORNEY REVIEW.** This is a working template, not legal advice. Nothing here is approved, and it isn't guaranteed to be enforceable. Agreement version: `2026-10-12-draft`.

Everything below is already live in the code. The agreement text comes from `lib/agreement.mjs`, and the checkout page, the `/rental-agreement` page and the confirmation email all read from it. Change the wording only there, and bump `AGREEMENT_VERSION` when you do.

Settings live in `lib/catalog.mjs`:

| Setting | Value |
|---|---|
| Deposit hold, 2021 Cadillac Escalade | $750 |
| Deposit hold, BMW 650i Convertible | $500 |
| Deposit hold, Cadillac SRX | $250 |
| Deposit hold, 2019 Honda Odyssey | $250 |
| Smoking / vaping fee | $150 |
| Hold placed | 24 hours before pickup, or right after payment if pickup is sooner |
| Auto-release | 72 hours after the scheduled return, unless you press "Keep hold" |
| Legal venue | Dallas County |

---

## 1. Clickwrap consent text (next to the checkbox)

The checkout page fills in the trip total and the deposit for the car:

> By checking this box, I am electronically signing the Ace Fares Rental Agreement (version 2026-10-12-draft) and agree that my electronic signature is as legally binding as my handwritten signature. I confirm that I am at least 21, hold a valid driver's license, and carry auto insurance that covers me in a rental vehicle. I authorize Ace Fares to charge my payment method **[$TRIP TOTAL]** for this trip, to place a refundable **[$DEPOSIT]** security deposit hold on it, and to collect from that hold or my card any amounts I owe under the agreement, including the non-negotiable $150 smoking and vaping fee. I agree to receive the agreement and related records electronically.

A **"Key rental terms"** box appears directly above the checkbox:

- **Security deposit hold: [$DEPOSIT].** This is a temporary hold on your card through Stripe, not a charge. It goes on [right after you pay / about 24 hours before pickup]. It's released within 72 hours after you return the car if nothing is owed. Your bank may take up to 10 business days to clear it.
- **No smoking or vaping: zero tolerance.** A non-negotiable $150 fee applies if we find any sign of smoking or vaping in the car.
- **Insurance:** show proof at pickup of your own auto insurance that covers rentals.
- **Disputes:** Texas law, Dallas County courts.
- A link to read the full rental agreement.

---

## 2. Rental agreement clauses (new and rewritten)

These sections are copied from `lib/agreement.mjs`. Where it says "for this vehicle", the booked car's deposit amount is filled in.

### 1. Parties, vehicle and direct rental
This Rental Agreement ("Agreement") is a direct vehicle lease between Ace Fares Rental Company of Dallas, Texas ("Ace Fares", "Lessor", "we", "us"), as the owner and lessor of the vehicle, and the renter named below ("Renter", "Lessee", "you"), as the lessee.

Ace Fares owns the vehicle or has the legal right to rent it, and rents it to you directly. Ace Fares is not a peer-to-peer car sharing platform, broker or marketplace, and no third-party host is a party to this Agreement. You receive the right to use the vehicle for the rental period only and no ownership interest in it.

### 2. Electronic signature and records
You sign this Agreement electronically by checking the agreement box at checkout and pressing Book trip. You agree that your electronic signature has the same legal effect as a handwritten signature, as provided by the Texas Uniform Electronic Transactions Act (Texas Business and Commerce Code, Chapter 322) and the federal E-SIGN Act (15 U.S.C. section 7001 and following).

You consent to receive this Agreement, receipts, notices and other records about your rental electronically, by email and on our website. You may ask for a free paper copy at any time, and you may withdraw this consent for future records, by emailing acefaresrental@gmail.com. To receive electronic records you need internet access and an email account.

When you sign, we record the date and time, your IP address, your browser, the version of this Agreement and a digital fingerprint (SHA-256) of the exact text you agreed to, and we store that record with your booking and your payment.

### 4. Payment, taxes and saved card (added paragraph)
You authorize Ace Fares to save the payment method you used at checkout with our payment processor, Stripe, and to use it for the security deposit hold (section 5) and for any amounts you owe under this Agreement. Charges that can only be known after the trip, such as extra miles, fuel, tolls, tickets, late return, cleaning, smoking or damage, are due when we send you an itemized statement.

### 5. Security deposit hold
**Amount.** A refundable security deposit is required for every rental: [$DEPOSIT] for this vehicle. It is a temporary authorization hold on your card, not a charge. The held funds are not available to you while the hold is in place (on a debit card, this reduces your available bank balance), but they are not taken from your account unless you owe us money under this Agreement.

**When it is placed.** We place the hold through Stripe on the card you paid with: right after you pay if pickup is less than 24 hours away, otherwise about 24 hours before pickup. Card holds expire after about 7 days (up to 30 days on some cards), so for longer rentals you authorize us to place a new hold for the same amount when an earlier one is about to expire.

**If the hold can't be placed.** If your card declines the hold or needs your approval, you must provide another acceptable card before handoff. If no deposit can be secured, we may refuse handoff and cancel the rental, and the cancellation policy in section 15 applies.

**When it is released.** After the vehicle is returned, we inspect it. If you owe nothing, we release the full hold within 72 hours after the scheduled return time. Once we release it, your bank removes the hold from your account. Most banks do this within a few business days, but some take up to 10 business days; that timing is controlled by your bank, not by Ace Fares. A hold that expires on its own is removed the same way.

**Charges from the deposit.** We may collect all or part of the hold for amounts you owe under this Agreement, including the smoking fee (section 12), cleaning, fuel, extra miles, late return, tolls, tickets and damage. We will send you an itemized statement, with photos where relevant, when we collect. Any part we do not collect is released. The deposit is not a limit on what you owe: if you owe more than the deposit, we will charge the balance to your card on file or bill you for it.

### 6. Insurance verification
You must have a personal auto liability insurance policy that is in force for the entire rental, covers you while driving a rented vehicle, and provides at least the minimum liability limits required by Texas law (currently $30,000 per injured person, $60,000 per accident for injuries, and $25,000 for property damage; Texas Transportation Code section 601.072). We strongly recommend collision and comprehensive coverage that extends to rental vehicles.

Before handoff you must show a current insurance card or declarations page in your name. You authorize us to contact your insurer or agent to confirm your coverage. If you cannot show proof, or your coverage cannot be confirmed, we may refuse handoff and the cancellation policy in section 15 applies.

Ace Fares does not sell you insurance or a damage waiver, and this Agreement does not give you any insurance coverage. Any insurance Ace Fares carries is for Ace Fares' protection, except where the law requires otherwise. To the extent permitted by law, your insurance is primary for any loss, damage or injury arising from the rental. Coverage offered by a credit card is usually secondary and may exclude some vehicles; check with your card issuer before you rely on it.

### 7. Responsibility for the vehicle and liability
From handoff until we take the vehicle back, you are responsible for the vehicle and for all loss of or damage to it, whatever the cause and whoever is at fault, including collision, theft, vandalism, hail and flood. To the extent permitted by Texas law, this includes the reasonable cost of repair (or the vehicle's fair market value if it is a total loss or not recovered), towing and storage, appraisal, and the rental income we lose while the vehicle is out of service (loss of use). You are also responsible for injury to people or damage to property caused by your use of the vehicle, to the extent not paid by insurance.

**INDEMNITY. TO THE FULLEST EXTENT PERMITTED BY TEXAS LAW, YOU AGREE TO DEFEND, INDEMNIFY AND HOLD HARMLESS ACE FARES AND ITS OWNERS AND EMPLOYEES FROM ALL CLAIMS, LOSSES, FINES, COSTS AND REASONABLE ATTORNEY'S FEES ARISING FROM YOUR USE OF THE VEHICLE, OR ITS USE BY ANY DRIVER YOU ALLOW, EXCEPT TO THE EXTENT CAUSED BY ACE FARES' OWN NEGLIGENCE OR WILLFUL MISCONDUCT.**

Ace Fares is not responsible for personal property left in the vehicle, or for indirect or consequential losses such as missed travel or lost earnings, except where the law does not allow this limit. Nothing in this Agreement waives rights you have that cannot be waived under Texas law, including under the Texas Deceptive Trade Practices-Consumer Protection Act.

### 12. No smoking or vaping: zero tolerance
**SMOKING OR VAPING ANYTHING IN THE VEHICLE, BY ANYONE, AT ANY TIME DURING YOUR RENTAL, IS PROHIBITED. THIS INCLUDES CIGARETTES, CIGARS, MARIJUANA, E-CIGARETTES AND VAPES, EVEN WITH THE WINDOWS OPEN.**

If we find any evidence of smoking or vaping when the vehicle is returned, including smoke or vapor odor, ash, cigarette or cigar butts, rolling papers, vape devices or cartridges, or burn marks, a smoking remediation fee of $150 applies. This fee is not negotiable. It is a pre-agreed amount reflecting the reasonable cost of odor treatment, deep cleaning and the time the vehicle is out of service, which are hard to measure exactly for each rental; it is not a penalty.

We will notify you within 48 hours after return, with dated photos and a description of what we found. You authorize us to collect the fee from your security deposit hold or your card on file. Burn holes, stains or other damage are charged separately under section 7.

### 17. Governing law and venue
This Agreement is governed by the laws of the State of Texas. To the extent permitted by law, any lawsuit about this Agreement or the rental must be brought in the state courts located in Dallas County, Texas, including the justice courts for small claims, and both parties agree to venue there. This does not waive any right Texas law gives you to be sued in the county where you live or where you signed this Agreement.

---

## 3. HTML/JS clickwrap (as built in `public/checkout.html`)

```html
<label class="agree" id="agree-row">
  <input type="checkbox" id="agree" aria-describedby="agree-text">
  <span id="agree-text"><!-- clickwrap text from the server (section 1) --></span>
</label>
<button class="btn" type="submit" id="pay-btn" disabled>Book trip</button>
<p class="sign-hint" id="sign-hint">Check the box above to sign the rental agreement and continue.</p>

<script>
let TERMS = null;      // { version, deposit, smokingFee, clickwrap } from GET /api/checkout-details
let agreedAt = null;   // when the box was checked (browser clock; the server records its own)

function syncButton() {
  const on = document.getElementById("agree").checked;
  document.getElementById("pay-btn").disabled = !on;   // stays disabled until checked
  document.getElementById("sign-hint").hidden = on;
}
document.getElementById("agree").addEventListener("change", e => {
  agreedAt = e.target.checked ? new Date().toISOString() : null;
  syncButton();
});

form.addEventListener("submit", async e => {
  e.preventDefault();
  if (!document.getElementById("agree").checked) return;   // belt and braces
  // 1) check card fields  2) record signature on the server  3) pay
  const sub = await elements.submit(); if (sub.error) return;
  const r = await fetch("/api/checkout-details", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ car, ref, name, email, phone,
      agree: true, agreedAt, termsVersion: TERMS.version }) });
  if (!r.ok) return;   // e.g. 409 terms_changed: ask them to refresh and re-sign
  await stripe.confirmPayment({ elements, confirmParams: { return_url: location.origin + "/?booking=success" }, redirect: "if_required" });
});
</script>
```

**Why the IP address isn't read in the browser:** a web page can't see its own public IP without calling a third-party service, and anything the browser sends can be faked. So the server records the IP from Netlify's connection details (`context.ip`, or the `x-nf-client-connection-ip` header) and uses its own clock for the official signing time. The browser's time is kept as a second reference. The server also refuses a signature on an outdated agreement version, and Book trip can't be pressed without the box: the server rejects `agree !== true`.

---

## 4. Logging the signature to Stripe (as built in `lib/handlers.mjs`)

```js
// POST /api/checkout-details (Netlify function receives (req, context))
const signedAt = new Date().toISOString();                     // server time = official
const ip = context.ip || req.headers.get("x-nf-client-connection-ip");
const words = clickwrapText({ total, deposit });               // exact checkbox text
const sha256 = createHash("sha256").update(agreementText(bookingWithRenter) + "\n\n" + words).digest("hex");

await stripe.paymentIntents.update(paymentIntentId, {
  customer: customerId,                 // saved card for the deposit hold
  receipt_email: email,
  metadata: {
    contract_signed: "true",
    contract_method: "clickwrap_checkbox",
    contract_signed_at: signedAt,
    contract_client_time: agreedAtFromBrowser,
    contract_version: AGREEMENT_VERSION,
    contract_sha256: sha256,
    signer_ip: ip,
    signer_user_agent: userAgent.slice(0, 500),
    deposit_policy_ack: "true",
    deposit_hold_amount: "750.00",
    smoking_policy_ack: "true",
    smoking_fee: "150.00",
  },
});
```

The signature record is kept in **four places**:

| Where | What it holds |
|---|---|
| Stripe → Payments → the payment → Metadata | The fields above. The deposit-hold payment carries the same version, fingerprint and signing time. |
| Netlify Blobs, `signed-agreement-<booking id>` | A full copy of the exact text they signed, plus the signature record. |
| The booking record | `signature` (shown on your bookings page: time, IP, version). |
| The renter's confirmation email | A "Signature record" table and the words they agreed to. |

To prove a signature later, rebuild the text for that version and booking from git history and hash it. The result must match `contract_sha256`.

---

## 5. How the deposit hold works

1. **At checkout.** The card is saved: the rental payment uses `setup_future_usage: "off_session"` and a Stripe Customer is created.
2. **Placing the hold.** A separate PaymentIntent is created with `capture_method: "manual"`, `off_session: true` and `confirm: true`, plus `request_extended_authorization: "if_available"`. This happens right after payment if pickup is within 24 hours. Otherwise the hourly job (`netlify/functions/deposit-holds.mjs`) places it 24 hours before pickup.
3. **How long it lasts.** Card holds last about 7 days, or up to 30 days with Stripe extended authorization. Stripe offers that on IC+ pricing; on standard pricing you have to ask Stripe support for it. For long rentals, the hourly job renews the hold before it expires.
4. **Your bookings page.** It shows each hold and has these buttons:
   - **Collect…**: partial capture. You enter an amount and a reason, and the rest is released.
   - **Release**
   - **Keep hold**: stops the automatic release while you look into damage.
   - **Try again**: for a hold that failed.
5. **If a hold fails.** For example, the card declines it or the bank wants the renter's approval. The booking shows **Hold failed** and you get an email, if Gmail is set up. Collect a deposit another way at handoff.
6. **Automatic release.** 72 hours after the scheduled return, if you haven't kept or collected it.

---

## 6. Questions for the attorney (open items)

- **Venue.** Texas Civil Practice & Remedies Code §15.035(b) may require suits on consumer contracts to be filed where the consumer lives or signed. That's why the clause says "to the extent permitted by law" and keeps that right.
- **The $150 smoking fee.** It's written as liquidated damages, not a penalty. Texas enforces these only if the harm is hard to estimate and the amount is a reasonable forecast (Phillips v. Phillips, 820 S.W.2d 785 (Tex. 1991)). The attorney should confirm $150 holds up.
- **Indemnity.** It's in bold capitals for the fair-notice rules (Dresser Industries v. Page Petroleum, 853 S.W.2d 505 (Tex. 1993)), and it deliberately doesn't cover Ace Fares' own negligence.
- **Charges after damage.** Confirm that loss-of-use, appraisal and administrative charges are allowed and are worded acceptably.
- **E-SIGN consumer consent.** Confirm whether the consent and disclosure wording in section 2 is enough, or whether the renter must show they can access electronic records before consenting.
- **Insurance.** Confirm the insurance clause matches your actual commercial or fleet policy. Who holds each car's title also affects the "owner and lessor" wording.
- **Blanks still to fill.** Extra-mile rate, late fee, fuel fee, cleaning fee, ticket fee, cancellation policy and out-of-state travel.

Sources:

- [Stripe: Place a hold on a payment method](https://docs.stripe.com/payments/place-a-hold-on-a-payment-method)
- [Stripe: Extended authorization](https://docs.stripe.com/payments/extended-authorization)
