# Demo V2 — End-to-End Verification

Status:
PASS

## Scenario Verified

### Seller

- user: seller01
- branch: Centro
- 2 x Remera Básica Negro/M
- 1 x Jean Slim Azul/42
- total ARS 165.000
- sale sent to cashier
- status PENDING_PAYMENT

### Cashier

- user: cashier01
- branch: Centro
- cash session opened
- pending sale visible
- split payment registered
- total ARS 165.000
- status PAID
- sale finalized
- status COMPLETED

### Admin

- user: admin
- completed sale visible
- dashboard reflects sale
- inventory reflects decremented stock

## Expected Final Inventory

- Remera Básica Negro/M: 20 -> 18
- Jean Slim Azul/42: 20 -> 19

## Result

Complete Seller -> Cashier -> Admin vertical flow works with persisted PostgreSQL state.

## Notes

- Verification was manual using separate browser sessions.
- No application code changes were required.
- Demo database was reset before verification using `npm run demo:reset`.
