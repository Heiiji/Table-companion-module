import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkSignatureSupport,
  signatureSupport,
} from "../src/rpc/signatureSupport.js";

// WebCrypto exists only in a secure context; the probe names why the backend's
// signatures cannot be verified here, and never throws.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkSignatureSupport", () => {
  it("is ok in a secure context with Ed25519", async () => {
    vi.stubGlobal("isSecureContext", true);
    expect(await checkSignatureSupport()).toBe("ok");
    expect(signatureSupport()).toBe("ok");
  });

  it("reports a plain-http page as an insecure context", async () => {
    vi.stubGlobal("isSecureContext", false);
    expect(await checkSignatureSupport()).toBe("insecure-context");
    expect(signatureSupport()).toBe("insecure-context");
  });

  it("reports a secure context without crypto.subtle", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("crypto", {});
    expect(await checkSignatureSupport()).toBe("no-subtle");
  });

  it("reports a WebCrypto that cannot import an Ed25519 key", async () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("crypto", {
      subtle: {
        importKey: () => Promise.reject(new Error("NotSupportedError")),
      },
    });
    expect(await checkSignatureSupport()).toBe("no-ed25519");
  });
});
