# Fishbowl Data Context

What the bridge reads out of Fishbowl Advanced 25.9, field by field, with the semantics and traps that are not
obvious from the column names. Everything here is **read-only** — the bridge only ever calls login / data-query /
logout (D-FB-01). Column names are verified against the live TEST database on the date each section says; anything
unverified is called out as such and the code degrades rather than guessing (see `tools/fishbowl-bridge/README.md`).

Companion documents: `Docs/Implementation_Plans/FB1_Implementation_Plan.md` §7.7 (the SO/soitem names the Order
Queue depends on) and `S11_Implementation_Plan.md` §7 (the pricing mirrors). Decisions: `Docs/Decisions.md`.

## Shared conventions

- **Timestamps.** Fishbowl stores and compares naive local datetimes on America/New_York, and its data-query returns
  them with a truncated offset (`2026-08-24T11:53:35.812-04`). Values going *into* a `WHERE` clause are rendered as
  `'YYYY-MM-DD HH:MM:SS'` in that zone (`fbDateTime`, mapper.mjs); values coming *out* get the offset expanded to
  `-04:00` (`ts`) so Postgres can cast them to `timestamptz`.
- **Decimals.** Quantities and prices arrive as strings — `"800.000000000"`, `"0E-9"`. Always coerced with `num()`.
- **Booleans.** `activeFlag` and friends come back as `1`/`0`, `"1"`/`"0"` or `true`/`false` depending on the column.
- **Encoding.** A description byte is occasionally cp1252 rather than UTF-8; responses are decoded strictly and fall
  back to latin1 per response (D-FB-31).
- **Salesman is a username, never a display name.** `so.salesmanId` and `customer.defaultSalesmanId` are `sysuser.id`;
  the bridge always joins `sysuser` and sends `sysuser.userName` (`cexum`, `sgriner`). `so.salesman` — a denormalised
  text column on the order — is *not* the same thing and is not used for the pricing mirrors (D-PRICE-20).

## SO status ids (`so.statusId`)

| id | meaning | in SkyNet |
|---|---|---|
| 10 | Estimate | never ingested at all (D-FB-11), and excluded from history |
| 20 | Issued | Order Queue |
| 25 | In Progress | Order Queue |
| 60 | Fulfilled | closes the SO; history keeps it |
| 70 | Closed Short | closes the SO; history keeps it |
| 80 | Voided | dead — raises exceptions on linked CO lines; excluded from history |
| 85 | Cancelled | dead — same; excluded from history |
| 90 | Expired | dead — same; excluded from history |
| 95 | Historical | Fishbowl's own archive marker |

Line statuses (`soitem.statusId`): 10–14 pre-pick, 20–40 picking, 50 Fulfilled, 60 Closed Short, 70 Voided,
75 Cancelled. Line types (`soitem.typeId`): 10 Sale, 11 Misc Sale, 12 Drop Ship, 30 Discount %, 80 Kit header;
11/20/21/31/40/50/60/70/90 are non-product lines.

---

## `customer` — the customer master (bridge v1.3, verified 2026-09-03)

Fishbowl is the customer master (D-PRICE-18): tiers, exceptions and purchase history all key on `customer.id`,
mirrored as `fb_customers.fb_customer_id`. SkyNet's own `customers` table is *linked* to it, never authoritative.

| Fishbowl | → `fb_customers` | Notes |
|---|---|---|
| `customer.id` | `fb_customer_id` (PK) | The pricing key. Stable. |
| `customer.number` | `customer_number` | The human account number. The RPC self-links SkyNet `customers.customer_id` (text) on this value — that is the only join between the two masters. |
| `customer.name` | `name` | Stored raw. |
| — | `name_clean` | Computed **server-side** by `_fb_clean_name()`: strips a trailing rep tag (`/AB`, `/CE`, `/PM`, `/SG`, `/HC`) and collapses double spaces. 459 names still carry a tag until Matt's Fishbowl rename runs; after it runs the poller self-heals and `name_clean` simply equals `name` (D-PRICE-20). |
| `customer.activeFlag` | `is_active` | 13,979 customers were inactivated in the 2026-09-03 cleanup. Inactive customers are still mirrored — their history is still wanted. |
| `customer.defaultSalesmanId` → `sysuser.userName` | `salesman` | **Username**, not display name. |
| `customer.defaultPaymentTermsId` → `paymentterms.name` | `payment_terms` | `paymentterms` is the one table name in this section **not** confirmed on 25.9. If the join fails the bridge drops it, logs once, and sends `paymentTerms: null` for the life of the process. |
| `customer.accountId` → account groups | `account_groups text[]` | See below. |
| `customer.dateCreated` / `dateLastModified` | `fb_date_created` / `fb_date_modified` | `dateLastModified` drives the incremental poll. |

**Account groups.** Membership does not hang off the customer directly — it hangs off its *account*:
`accountgrouprelation(id, accountId, groupId)` joined to `accountgroup(id, name)`, mapped onto customers by
`customer.accountId`. Column names for `accountgrouprelation` were confirmed 2026-09-03; `accountgroup` was not, so
the read is wrapped: on failure the poller sends no `groups` key at all and the RPC keeps whatever is stored, rather
than blanking the array. Phase F will write Tier 1/2/3/Premier back as account groups (D-PRICE-24), so this mapping
is the baseline for that parity check.

**Polling.** Every `POLL_CUSTOMERS_SEC` (900 s). First run — `fb_sync_state.last_customers_at IS NULL` — is a full
backfill of all ~6.5k active + inactive rows; afterwards `WHERE c.dateLastModified > last_customers_at − 1 hour`.
The hour of overlap covers a customer saved while the previous poll was mid-flight; the upsert is keyed on
`fb_customer_id`, so re-reading a row costs nothing.

---

## `product` — the product list (bridge v1.3, verified 2026-09-03)

10,980 rows. Gives the Resale section its Eaches (D-PRICE-13), links `price_items.fb_product_id` by product
number, and is Phase F's write-back parity baseline.

| Fishbowl | → `fb_products` | Notes |
|---|---|---|
| `product.id` | `fb_product_id` (PK) | |
| `product.num` | `product_num` | The catalog SKU. `product_key` (generated: upper-cased, whitespace stripped) is what everything joins on — Fishbowl part numbers are entered inconsistently. |
| `product.partId` → `part.num` | `part_num` | A product *has* a part; the two numbers usually match but not always, and a product may have no part. |
| `product.description` | `description` | |
| `product.price` | `list_price numeric(12,3)` | Fishbowl's list price, rounded to 3 dp by the RPC to match the price book's Each (D-PRICE-02). 115 of these disagreed with the Rev 81 guide at discovery — the portal's book wins; the Products CSV export exists to push these back by hand until Phase F (D-PRICE-22). |
| `product.activeFlag` | `is_active` | 6,189 active products have never sold. |

**Polling.** The whole table nightly at `PRODUCTS_NIGHTLY_AT` (02:10 local), plus `--backfill`, in 500-row batches.
No incremental mode: at 11k rows a full snapshot is cheaper than tracking changes, and it self-heals.

---

## `so` / `soitem` — the history slice (bridge v1.3, verified 2026-09-03)

The Order Queue mirrors *open* orders only (Issued + In Progress, D-FB-17); D-FB-17 deliberately left everything
else in Fishbowl until a round needed it. The Pricing Portal is that round: `fb_so_history_lines` holds every
product line the company has sold since **2023-11-27**, so a customer's paid prices can be shown beside the book's
(D-PRICE-19). Same two tables as the Order Queue, a different slice of them.

```sql
FROM soitem si JOIN so s ON s.id = si.soId
LEFT JOIN product p ON p.id = si.productId
LEFT JOIN part pt ON pt.id = p.partId
LEFT JOIN sysuser su ON su.id = s.salesmanId
WHERE si.typeId IN (10, 12) AND s.statusId NOT IN (10, 80, 85, 90)
```

| Fishbowl | → `fb_so_history_lines` | Notes |
|---|---|---|
| `soitem.id` | `fb_soitem_id` (PK) | The same key the open mirror uses, which is how `v_customer_purchases` de-dupes the two sources. |
| `so.id` / `so.num` | `fb_so_id` / `so_number` | |
| `so.customerId` | `fb_customer_id` | Joins to `fb_customers`. |
| `so.statusId` / `soitem.statusId` / `soitem.typeId` | `so_status_id` / `line_status_id` / `line_type_id` | Kept raw; the portal labels them from `src/lib/fishbowl.js`. |
| `soitem.productNum` | `product_num` (+ generated `product_key`) | The line's own product number, not the product record's — a line can outlive a renamed product. |
| `product.partId` → `part.num` | `part_num` | |
| `soitem.qtyOrdered` / `qtyFulfilled` | `qty_ordered` / `qty_fulfilled` | `v_customer_purchases` counts **fulfilled** quantity — what the customer actually took. |
| `soitem.unitPrice` / `totalPrice` | `unit_price numeric(12,4)` / `total_price` | 4 dp: paid prices carry more precision than book Eaches. `last_paid` on the view is the most recent non-null. |
| `so.dateCreated` / `so.dateCompleted` | `fb_date_created` / `fb_date_completed` | Order dates, not line dates — history is aggregated per customer × part, so the header date is the useful one. |
| `so.salesmanId` → `sysuser.userName` | `salesman` | Username again. |
| `so.dateLastModified` | — (the cursor) | Not stored on the line; it drives paging only. |

**Scope decisions.** Product lines only (`typeId` 10 Sale and 12 Drop Ship — the pair D-FB-08 calls `PRODUCT_LINE_TYPES`;
the Batch A brief said 30, which is **Discount %**, not drop ship, and was corrected in B.1) — freight, discounts and notes are not
purchases. Estimates (10) never leave Fishbowl at all; Voided (80), Cancelled (85) and Expired (90) are dead orders
and would misreport what a customer pays. Everything else is in, **including open orders**: the history table is
meant to be complete on its own, and `v_customer_purchases` drops a history row's twin from the open mirror by
`fb_soitem_id` rather than the other way round.

**Polling.** Nightly at `HISTORY_NIGHTLY_AT` (02:20 local), plus `--backfill`. Paged by
`ORDER BY s.dateLastModified, si.id LIMIT 2000` from `fb_sync_state.history_cursor` (`HISTORY_BACKFILL_FROM` when
there is none), re-running with the last `dateLastModified` seen until a page comes back short. Each page's own max
`dateLastModified` is passed to the RPC as the new cursor when that page's last batch lands, so an interrupted
backfill resumes rather than restarting; a partial batch passes `NULL` and leaves the cursor where it was. Boundary
overlap is harmless — the upsert is keyed on `fb_soitem_id`. The backfill is ~35k lines over ~20 pages.

Because the cursor is `so.dateLastModified`, *any* touch to an order re-reads all of its lines. That is the point:
a price corrected on a two-year-old order flows through on the next nightly run.
