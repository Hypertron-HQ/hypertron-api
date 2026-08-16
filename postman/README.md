# Hypertron Render Postman collection

## Import

1. In Postman, select **Import**.
2. Import `Hypertron_Render.postman_collection.json`.
3. Import `Hypertron_Render.postman_environment.json`.
4. Select the **Hypertron Render** environment.

You can also paste the full collection JSON into Postman's **Import → Raw
text** dialog.

## Required environment values

Set these three secret values before running the collection:

- `serviceAccountApiKey` — core backend `ht_svc_...` key
- `internalServiceToken` — must match the API's `INTERNAL_SERVICE_TOKEN`
- `authSecret` — must match the API's `AUTH_SECRET`

The collection obtains `businessId` and `walletAddress` from the core backend,
generates the dashboard cookie, creates a temporary `sk_test_` API key, and
chains all generated resource IDs automatically.

If an exported curl shows `Authorization: Bearer ` with nothing after it, the
merchant key has not been generated yet. Run **02 — Developer API keys → Create
test API key** and confirm that the selected environment's `merchantApiKey`
value starts with `sk_test_` before running or exporting payment requests.

## Run order

Run the folders from `00` through `06`. The final folder rotates and revokes the
temporary merchant API key. The webhook endpoint is deleted after its tests.

The manual webhook-delivery retry can return 404 while Redis and workers are
disabled because no queued delivery record exists. The direct test-webhook
request remains usable.

The run creates test payments and customer records in the deployed database.
Use a non-production business/service account when possible.

Regenerate both JSON files with:

```sh
pnpm postman:generate
```
