/*
 * Rights for Humans, Not Robots
 * Signature collection is intentionally inactive until a verified backend
 * endpoint is configured. Never present a signature as saved without a
 * successful server response and email-confirmation workflow.
 */
const FORM_ENDPOINT = ""; // Configure only after the signing backend is ready.
const SHARE_URL = "https://rightsforhumansnotrobots.org/";

const form = document.getElementById("proclamation");
const errorEl = document.getElementById("error");
const signButton = document.getElementById("signBtn");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.textContent = "";

  const data = Object.fromEntries(new FormData(form).entries());
  data.agree = document.getElementById("agree").checked;
  data.human = document.getElementById("human").checked;
  data.confirmation_only = !document.getElementById("updates_opt_in").checked;
  data.updates_opt_in = document.getElementById("updates_opt_in").checked;
  data.opinion_topic = document.getElementById("opinion_topic").value;
  data.opinion_text = document.getElementById("opinion_text").value.trim();
  data.affirm = document.getElementById("affirm").checked;
  data.signed_at = new Date().toISOString();
  data.page = window.location.href;

  if (data.website) return;
  if (!data.affirm) return fail("Please affirm the statement about human authorship.");
  if (!data.name || data.name.trim().length < 2) return fail("Please add your name. Proclamations need signatures.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email || "")) return fail("Please enter a valid email address.");
  if (!data.agree) return fail("Please confirm that you have read and agree to sign the Proclamation.");
  if (data.opinion_text.length > 1000) return fail("Please keep your comments within 1,000 characters.");
  if (!data.human) return fail("Please confirm that you are not a robot.");

  if (!FORM_ENDPOINT) {
    return fail("The signing service is not connected yet. Your information has not been submitted or stored.");
  }

  signButton.disabled = true;
  signButton.textContent = "Sealing…";
  try {
    const response = await fetch(FORM_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(data)
    });
    if (!response.ok) throw new Error("Signature submission failed");
    document.getElementById("form-body").hidden = true;
    document.getElementById("thanksName").textContent = "Thank you, " + data.name.trim().split(/\s+/)[0];
    document.getElementById("success").classList.add("show");
    document.getElementById("success").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    fail("We couldn't submit your signature. Please try again later.");
    signButton.disabled = false;
    signButton.innerHTML = "Sign the<br>Proclamation<span>✦ SEAL IT ✦</span>";
  }
});

function fail(message) {
  errorEl.textContent = message;
}

document.getElementById("copyLink").addEventListener("click", async (event) => {
  try {
    await navigator.clipboard.writeText(SHARE_URL);
    event.currentTarget.textContent = "Copied!";
  } catch {
    event.currentTarget.textContent = SHARE_URL;
  }
});

document.getElementById("shareBtn").addEventListener("click", async () => {
  const shareData = {
    title: "Copyrights for Humans",
    text: "I support the Proclamation: copyright should protect human creators.",
    url: SHARE_URL
  };
  if (navigator.share) {
    try { await navigator.share(shareData); } catch { /* User cancelled sharing. */ }
  } else {
    const intent = "https://twitter.com/intent/tweet?text=" +
      encodeURIComponent(shareData.text) + "&url=" + encodeURIComponent(SHARE_URL);
    window.open(intent, "_blank", "noopener,noreferrer");
  }
});
