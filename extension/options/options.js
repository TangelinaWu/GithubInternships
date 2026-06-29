// Options page — loads profile from storage and saves changes

const TEXT_FIELDS = [
  "firstName", "lastName", "email", "phone",
  "address", "city", "state", "zipCode", "country",
  "linkedinUrl", "githubUrl", "portfolioUrl", "websiteUrl",
  "currentTitle", "yearsOfExperience", "desiredSalary",
  "university", "fieldOfStudy", "graduationYear",
  "skills", "professionalSummary", "coverLetterTemplate",
  "gpa", "relevantCoursework", "workExperience", "projects", "certifications",
  "targetRoles", "preferredIndustries",
  "linkedinEmail", "linkedinPassword", "claudeApiKey",
];

const SELECT_FIELDS = [
  "workAuthorization", "highestDegree",
  "gender", "ethnicity", "veteranStatus", "disabilityStatus",
];

const CHECKBOX_FIELDS = [
  "requiresSponsorship", "willingToRelocate", "canWorkRemote",
  "confirmUnknownQuestions", "autoSubmit", "pauseOnEachStep",
];

async function loadProfile() {
  const profile = await getProfile();

  for (const key of TEXT_FIELDS) {
    const el = document.getElementById(key);
    if (el && profile[key] !== undefined) {
      el.value = profile[key];
    }
  }

  for (const key of SELECT_FIELDS) {
    const el = document.getElementById(key);
    if (el && profile[key] !== undefined) {
      el.value = profile[key];
    }
  }

  for (const key of CHECKBOX_FIELDS) {
    const el = document.getElementById(key);
    if (el) {
      el.checked = !!profile[key];
    }
  }

  // Resume status
  const resumeStatus = document.getElementById("resumeStatus");
  if (profile.resumeFileName) {
    resumeStatus.textContent = `Current resume: ${profile.resumeFileName}`;
  }

  // API key status
  updateApiKeyStatus(profile.claudeApiKey);
}

function updateApiKeyStatus(key) {
  const el = document.getElementById("apiKeyStatus");
  if (!el) return;
  if (key && key.trim()) {
    el.textContent = "API key is set.";
    el.style.color = "#22c55e";
  } else {
    el.textContent = "No API key — AI suggestions won't work.";
    el.style.color = "#f97316";
  }
}

async function saveProfile() {
  const partial = {};

  for (const key of TEXT_FIELDS) {
    const el = document.getElementById(key);
    if (el) partial[key] = el.value.trim();
  }

  for (const key of SELECT_FIELDS) {
    const el = document.getElementById(key);
    if (el) partial[key] = el.value;
  }

  for (const key of CHECKBOX_FIELDS) {
    const el = document.getElementById(key);
    if (el) partial[key] = el.checked;
  }

  // Resume — only save if user uploaded a new file
  const resumeInput = document.getElementById("resumeUpload");
  if (resumeInput && resumeInput.files && resumeInput.files.length > 0) {
    const file = resumeInput.files[0];
    const dataUrl = await fileToDataUrl(file);
    partial.resumeFileName = file.name;
    partial.resumeDataUrl = dataUrl;
  }

  await window.saveProfile(partial);

  updateApiKeyStatus(partial.claudeApiKey);

  const banner = document.getElementById("save-banner");
  banner.classList.remove("hidden");
  setTimeout(() => banner.classList.add("hidden"), 2500);
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  loadProfile();
  document.getElementById("saveBtn").addEventListener("click", saveProfile);
});
