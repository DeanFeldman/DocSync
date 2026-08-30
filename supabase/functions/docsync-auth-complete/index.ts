const codePattern = /^[A-Za-z0-9._~-]+$/;

Deno.serve((request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");

    if (!code || !codePattern.test(code)) {
        return new Response("Sign-in could not be completed. Return to DocSync and try again.", {
            status: 400,
            headers: {
                "content-type": "text/plain; charset=utf-8",
                "referrer-policy": "no-referrer",
                "x-content-type-options": "nosniff"
            }
        });
    }

    const callback = `za.co.docsync://auth/callback?code=${encodeURIComponent(code)}`;

    return new Response(null, {
        status: 302,
        headers: {
            location: callback,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer"
        }
    });
});