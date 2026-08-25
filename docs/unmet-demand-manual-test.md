# Unmet Demand manual test checklist

1. Create a stop with two mapped buses and set only the targeted bus to zero Seats Available. Submit a rider Soft Hold for that bus and verify the existing rejection appears but no Unmet Demand entry is created.
2. Set every bus mapped to the stop to zero Seats Available. Repeat the Soft Hold and verify exactly one new row appears in the Admin dashboard within one second without refreshing.
3. Verify the live row shows the rider, stop, requested bus and server time, and that the Last 30 minutes and Today counts each increment once.
4. Refresh the Admin dashboard and verify the same event remains, appears only once, and matches `GET /api/admin/unmet-demand`.
5. Repeat through a BLE boarding prompt and verify the capacity rejection creates exactly one additional event while no occupied count or arrival event is added.
6. Use a stop with no mapped buses and verify it is not classified as unmet demand.
7. Send a short burst of rejected attempts and verify every request is stored while the Admin UI inserts them in a batched update rather than re-rendering once per socket packet.
8. Log in as a rider or rider with Incharge authority and verify `/api/admin/unmet-demand` returns `403` and the panel is not visible.
