# Healthcheck design

Add one early path and method check to `handleRequest`. Return JSON with an explicit content type. Keep the existing fallback unchanged and add no dependencies.
