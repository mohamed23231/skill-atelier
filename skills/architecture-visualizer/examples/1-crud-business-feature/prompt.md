# Scenario 1 Prompt: Supplier Discounts & Volume Rebates in Inventory Valuation

## User Request
> "We need to introduce supplier discounts and tiered volume rebates into our inventory valuation and purchasing calculation engine. Currently, inventory valuation is calculated strictly based on unit cost on the purchase order (`POItem.unit_price * quantity`). With our new supplier contracts, suppliers offer tier discounts based on annual spend and instantaneous volume discounts. When purchasing or revaluing inventory, the system must evaluate applicable discount rules, compute net inventory valuation, log an immutable audit entry for compliance, and expose the adjusted valuation via the Inventory API for financial reporting."

## Architectural Goals
1. Accurately model the existing purchasing and inventory services while introducing the new `supplier_discount_service`.
2. Clearly show what changes (`inventory_valuation_service` modified to fetch discounts; new tables and audit log).
3. Provide an interactive step-by-step sequence of discount evaluation and audit logging.
4. Establish concrete database ER schemas with foreign keys and index constraints.
5. Create a traceable 3-phase implementation plan grounded in repository files.
