/*
 * Rights for Humans, Not Robots
 * Submissions go same-origin to the signing Worker (routed on this domain to
 * the copyrights-for-humans Worker that also serves onlyuno.xyz). Nothing is
 * counted until the person opens the emailed confirmation link. Never present
 * a response as recorded without a successful server response.
 */
const FORM_ENDPOINT = "/api/sign";
const COUNT_ENDPOINT = "/api/count";
const SHARE_URL = "https://rightsforhumansnotrobots.org/";

const form = document.getElementById("proclamation");
const errorEl = document.getElementById("error");
const signButton = document.getElementById("signBtn");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.textContent = "";
  errorEl.style.display = "none";

  const data = Object.fromEntries(new FormData(form).entries());
  data.agree = document.getElementById("agree").checked;
  data.human = document.getElementById("human").checked;
  data.confirmation_only = !document.getElementById("updates_opt_in").checked;
  data.updates_opt_in = document.getElementById("updates_opt_in").checked;
  data.motivation = document.querySelector('input[name="motivation"]:checked')?.value || "";
  data.profession = document.getElementById("profession").value.trim();
  data.stance = document.querySelector('input[name="stance"]:checked')?.value || "";
  data.join_movement = data.stance === "for";
  data.publish_opinion = document.getElementById("publish_opinion").checked;
  data.opinion_text = document.getElementById("opinion_text").value.trim();
  data.public_comment = data.publish_opinion ? data.opinion_text : "";
  data.public_name = data.publish_opinion ? data.name.trim() : "";
  data.public_position = data.publish_opinion ? data.stance : "";


  if (data.website) return;
  if (!data.stance) return fail("Please select For or Against.");
  if (data.publish_opinion && !data.opinion_text) return fail("Please write an explanation if you want your named opinion shared publicly.");
  if (!data.name || data.name.trim().length < 2) return fail("Please add your name. Proclamations need signatures.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email || "")) return fail("Please enter a valid email address.");
  if (!data.agree) return fail("Please authorize recording your chosen position.");
  if (data.opinion_text.length > 1000) return fail("Please keep your comments within 1,000 characters.");
  if (!data.human) return fail("Please confirm that you are not a robot.");

  if (!FORM_ENDPOINT) return fail("Signing is not available right now. Nothing was recorded.");

  signButton.disabled = true;
  signButton.textContent = "Sealing…";
  try {
    const response = await fetch(FORM_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(data)
    });
    const out = await response.json().catch(() => ({}));
    if (!response.ok || !out.ok) throw new Error(out.error || "We couldn't submit your response. Nothing was recorded. Please try again later.");
    document.getElementById("form-body").hidden = true;
    document.getElementById("sentTo").textContent = data.email.trim();
    document.getElementById("thanksName").textContent = "Thank you, " + data.name.trim().split(/\s+/)[0];
    document.getElementById("success").classList.add("show");
    document.getElementById("success").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    fail(error && error.message && !/fetch|network/i.test(error.message) ? error.message : "We couldn't reach the signing service. Nothing was recorded. Please try again later.");
    signButton.disabled = false;
    signButton.innerHTML = "Record My<br>Position<span>✦ SEAL IT ✦</span>";
  }
});

function fail(message) {
  errorEl.textContent = message;
  errorEl.style.display = "block";
  errorEl.scrollIntoView({ behavior: "smooth", block: "center" });
  errorEl.focus({ preventScroll: true });
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
    text: "What do you think about protecting human rights and clarifying human personhood?",
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

async function loadCount() {
  try {
    const response = await fetch(COUNT_ENDPOINT, { headers: { "Accept": "application/json" } });
    if (!response.ok) return;
    const d = await response.json();
    if (typeof d.movement !== "number" || d.total_responses < 1) return;
    document.getElementById("t-for").textContent = d.movement.toLocaleString();
    document.getElementById("t-against").textContent = d.against.toLocaleString();
    document.getElementById("tally").hidden = false;
  } catch { /* Count is optional. */ }
}
loadCount();
