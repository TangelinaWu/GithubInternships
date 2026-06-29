// Profile defaults — flat object stored under "profile" key in storage.local
const PROFILE_DEFAULTS = {
  // Personal
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  address: "",
  city: "",
  state: "",
  zipCode: "",
  country: "United States",

  // Online presence
  linkedinUrl: "",
  githubUrl: "",
  portfolioUrl: "",
  websiteUrl: "",

  // Resume — stored as base64 Data URL (PDF, typically 50–200KB)
  resumeFileName: "",
  resumeDataUrl: "",

  // Work
  currentTitle: "",
  yearsOfExperience: "",
  desiredSalary: "",
  workAuthorization: "US Citizen",
  requiresSponsorship: false,
  willingToRelocate: false,
  canWorkRemote: true,
  referralSource: "LinkedIn",
  availableStartDate: "June 2026",

  // Education
  highestDegree: "Bachelor's",
  fieldOfStudy: "",
  university: "",
  graduationYear: "",
  graduationMonth: "May",

  // EEOC / demographics (optional — defaults to "prefer not to answer")
  gender: "Decline to self-identify",
  ethnicity: "Decline to self-identify",
  veteranStatus: "I am not a protected veteran",
  disabilityStatus: "I don't wish to answer",

  // Preferences
  canWorkRemote: true,
  willingToRelocate: false,

  // Text used by Claude when generating answers for open-ended questions
  professionalSummary: "",
  skills: "",
  coverLetterTemplate: "",

  // Account credentials (stored locally, used for auto-login)
  linkedinEmail: "",
  linkedinPassword: "",

  // Extended credentials — used by the auto-matcher for keyword scoring
  gpa: "",
  relevantCoursework: "",
  workExperience: "",
  projects: "",
  certifications: "",
  targetRoles: "",
  preferredIndustries: "",

  // App settings
  claudeApiKey: "",
  autoSubmit: false,
  confirmUnknownQuestions: true,
  pauseOnEachStep: false,
};

// Maps lowercased label text patterns to profile field keys.
// IMPORTANT: More specific / longer patterns must come FIRST.
// Short generic patterns (city, state, zip) come later with maxLabelLength guards
// to prevent false-matches on long question sentences (e.g. "state" matching "United States").
const FIELD_MAP = [
  // ── Long-sentence question patterns (specific first to avoid false-matching short field names) ──

  // Work authorization — Yes/No boolean (radio/dropdown), separate from the text "US Citizen" field
  { patterns: [
      "are you currently authorized to work in the united states",
      "legally authorized to work in the united states",
      "are you eligible to work in the united states",
      "currently authorized to work in the us",
      "legally eligible to work in the us",
    ], key: "__workAuthYes" },

  // Sponsorship — must come before the generic "state" pattern which false-matches "United States"
  { patterns: [
      "require employer sponsorship",
      "will you now or in the future require",
      "require sponsorship to work in",
      "need sponsorship to work",
      "do you currently or will you in the future require sponsorship",
    ], key: "__sponsorship" },

  // Prior internship / co-op experience
  { patterns: [
      "prior internship or co-op",
      "prior internship or coop",
      "previous internship",
      "internship or co-op experience",
      "co-op experience",
      "have you completed an internship",
      "have you had an internship",
      "do you have prior internship",
      "internship experience",
    ], key: "__internshipYes" },

  // Legal / terms consent checkboxes
  { patterns: [
      "i agree to the terms",
      "i accept the terms",
      "i certify that the information",
      "i confirm that the information",
      "i acknowledge that",
      "i authorize",
      "agree to the privacy policy",
      "terms and conditions",
      "by checking this box",
      "by submitting this application",
      "i attest that",
      "i have read and agree",
    ], key: "__termsConsent" },

  // Employment / job type
  { patterns: [
      "type of employment",
      "employment type",
      "job type",
      "type of role",
      "type of position",
      "position type",
      "type of work",
      "what type of role",
      "are you seeking full-time or part-time",
      "full-time or part-time",
      "full time or part time",
      "work arrangement type",
    ], key: "__jobType" },

  // Hybrid / in-office comfort
  { patterns: [
      "comfortable working in a hybrid",
      "comfortable with hybrid",
      "open to hybrid",
      "willing to work hybrid",
      "hybrid work arrangement",
      "comfortable working in office",
      "in-person or hybrid",
    ], key: "__canHybrid" },

  // Currently employed
  { patterns: [
      "are you currently employed",
      "current employment status",
      "currently working",
      "do you have a current employer",
    ], key: "__currentlyEmployed" },

  // On-site acknowledgment checkbox
  { patterns: [
      "i understand that this position requires me to work on-site",
      "i understand this position is on-site",
      "i understand this role requires on-site",
      "this position requires working on-site",
    ], key: "__onsiteAck" },

  // Can work on-site (question form)
  { patterns: [
      "are you willing to work on-site",
      "are you able to work on-site",
      "can you work on-site",
      "able to work in-office",
    ], key: "__canOnsite" },

  // Relocation — self-funded (No — we don't offer assistance)
  { patterns: [
      "able to relocate on your own if you are not based locally",
      "able to relocate on your own if not based locally",
      "able to self-relocate",
      "relocate on your own if not",
      "able to relocate without assistance",
      "if hired, are you able to relocate on your own",
      "we do not offer relocation assistance",
    ], key: "__relocateSelf" },

  // Background check consent
  { patterns: [
      "consent to a background check",
      "agree to a background check",
      "willing to submit to a background check",
      "background screening",
      "subject to a background check",
    ], key: "__bgConsent" },

  // Drug test consent
  { patterns: [
      "willing to take a drug test",
      "submit to a drug test",
      "drug screening",
      "pre-employment drug",
    ], key: "__drugTest" },

  // Age 18+
  { patterns: [
      "are you 18 years of age or older",
      "at least 18 years of age",
      "are you at least 18",
      "are you over 18",
    ], key: "__adultYes" },

  // How did you hear about this position
  { patterns: [
      "how did you hear about this position",
      "how did you find out about this position",
      "how did you learn about this opportunity",
      "how did you discover this",
      "where did you find this job",
      "how did you hear about us",
      "how were you referred",
      "referral source",
    ], key: "__referralSource" },

  // Current student status
  { patterns: [
      "are you a current student",
      "currently enrolled as a student",
      "currently enrolled in a degree program",
      "are you currently pursuing a degree",
      "are you enrolled in an accredited university",
      "pursuing a bachelor",
      "are you a full-time student",
    ], key: "__currentStudent" },

  // Graduation date (full month + year)
  { patterns: [
      "expected graduation date",
      "anticipated graduation date",
      "when do you expect to graduate",
      "expected date of graduation",
    ], key: "__gradDate" },

  // Graduation year (just year)
  { patterns: [
      "what year will you graduate",
      "expected graduation year",
      "when will you graduate",
      "graduation year (expected)",
    ], key: "graduationYear" },

  // Available start date
  { patterns: [
      "when are you available to start",
      "earliest available start date",
      "what is your earliest start date",
      "when can you start",
      "available start date",
      "start date availability",
    ], key: "__startDate" },

  // Full-time availability
  { patterns: [
      "are you available for full-time",
      "available to work full-time",
      "can you work full time",
    ], key: "__fullTime" },

  // Full-time after graduation
  { patterns: [
      "interested in full-time employment after graduation",
      "open to full-time after graduation",
      "interested in a return offer",
    ], key: "__ftAfterGrad" },

  // US citizenship (explicit question)
  { patterns: [
      "are you a us citizen",
      "are you a united states citizen",
      "us citizen or permanent resident",
    ], key: "__usCitizen" },

  // ── Short field label patterns (generic — order matters less here) ──

  { patterns: ["first name", "given name", "preferred first name", "first"], key: "firstName" },
  { patterns: ["last name", "family name", "surname", "last"], key: "lastName" },
  { patterns: ["full name", "legal name", "applicant name", "your name", "candidate name"], key: "__fullName" },
  // "name" alone must come AFTER first/last name entries — otherwise "first name" and
  // "last name" both match "name" here and get filled with the full name "Angelina Wu".
  { patterns: ["name"], key: "__fullName", maxLabelLength: 20 },
  { patterns: ["preferred name", "nickname", "goes by", "name (preferred)"], key: "firstName" },
  { patterns: ["email", "e-mail", "email address", "contact email"], key: "email" },
  { patterns: ["phone", "mobile", "telephone", "cell", "phone number", "contact number", "mobile number"], key: "phone" },
  // EEOC fields must come before "city" — "ethnicity" contains the substring "city"
  // and would false-match the city pattern if city came first.
  { patterns: ["gender", "sex"], key: "gender" },
  { patterns: ["race", "ethnicity", "racial", "hispanic", "latino"], key: "ethnicity" },
  { patterns: ["veteran", "military", "protected veteran"], key: "veteranStatus" },
  { patterns: ["disability", "disabled", "accommodation"], key: "disabilityStatus" },
  { patterns: ["address", "street address", "mailing address", "street"], key: "address" },
  // maxLabelLength prevents "city" matching inside long question sentences
  { patterns: ["city", "town", "city of residence"], key: "city", maxLabelLength: 50 },
  // maxLabelLength prevents "state" matching "United States" in long questions
  { patterns: ["state", "province", "region"], key: "state", maxLabelLength: 50 },
  { patterns: ["zip", "postal code", "zip code", "postcode"], key: "zipCode", maxLabelLength: 50 },
  { patterns: ["country"], key: "country", maxLabelLength: 50 },
  // Location (city, state combined) — maxLabelLength avoids long sentence matches
  { patterns: ["location", "current location", "city/state", "city, state", "where are you based", "where do you live"], key: "__cityState", maxLabelLength: 60 },
  { patterns: ["linkedin", "linkedin url", "linkedin profile", "linkedin profile url", "linkedin link"], key: "linkedinUrl" },
  { patterns: ["github", "github url", "github profile", "github link", "github username"], key: "githubUrl" },
  { patterns: ["portfolio", "personal website", "website url", "personal site", "portfolio url", "portfolio link"], key: "portfolioUrl" },
  { patterns: ["website", "personal url"], key: "websiteUrl" },
  { patterns: ["current title", "job title", "current position", "current role", "title"], key: "currentTitle" },
  { patterns: ["years of experience", "years experience", "how many years", "years of relevant experience"], key: "yearsOfExperience" },
  { patterns: ["salary", "compensation", "expected salary", "desired salary", "salary expectation", "salary range"], key: "desiredSalary" },
  { patterns: ["work authorization", "authorized to work", "eligible to work", "legally authorized"], key: "workAuthorization" },
  { patterns: ["require sponsorship", "visa sponsorship", "sponsorship", "require visa"], key: "__sponsorship" },
  { patterns: ["degree", "highest education", "highest degree", "education level", "highest level of education"], key: "highestDegree" },
  { patterns: ["university", "college", "school", "institution", "school name", "college name"], key: "university" },
  { patterns: ["field of study", "major", "area of study", "discipline", "degree major", "concentration"], key: "fieldOfStudy" },
  { patterns: ["graduation year", "grad year", "year of graduation", "expected graduation year"], key: "graduationYear" },
  { patterns: ["gpa", "grade point average"], key: "gpa", maxLabelLength: 40 },
  { patterns: ["cover letter"], key: "coverLetterTemplate" },
  { patterns: ["relocate", "willing to relocate", "open to relocation", "able to relocate"], key: "__relocate" },
  { patterns: ["remote", "work remotely", "work from home", "fully remote"], key: "__remote" },
  { patterns: ["start date", "earliest start", "available to start", "when can you start"], key: "__startDate", maxLabelLength: 60 },
  { patterns: ["skills", "technical skills", "core skills", "key skills"], key: "skills", maxLabelLength: 40 },
  { patterns: ["summary", "professional summary", "about you", "tell us about yourself", "brief bio"], key: "professionalSummary", maxLabelLength: 60 },
];

// Resolve special computed keys to actual string values
function resolveProfileValue(key, profile) {
  if (key === "__fullName")          return `${profile.firstName} ${profile.lastName}`.trim();
  if (key === "__cityState")         return [profile.city, profile.state].filter(Boolean).join(", ");
  if (key === "__sponsorship")       return profile.requiresSponsorship ? "Yes" : "No";
  if (key === "__relocate")          return profile.willingToRelocate ? "Yes" : "No";
  if (key === "__relocateSelf")      return profile.willingToRelocate ? "Yes" : "No";
  if (key === "__remote")            return profile.canWorkRemote ? "Yes" : "No";
  if (key === "__workAuthYes")       return profile.workAuthorization ? "Yes" : "No";
  if (key === "__internshipYes")     return "Yes";
  if (key === "__onsiteAck")         return "Yes";
  if (key === "__canOnsite")         return "Yes";
  if (key === "__canHybrid")         return "Yes";
  if (key === "__bgConsent")         return "Yes";
  if (key === "__drugTest")          return "Yes";
  if (key === "__adultYes")          return "Yes";
  if (key === "__currentStudent")    return "Yes";
  if (key === "__fullTime")          return "Yes";
  if (key === "__ftAfterGrad")       return "Yes";
  if (key === "__termsConsent")      return "Yes";
  if (key === "__jobType")           return "Internship";
  if (key === "__currentlyEmployed") return "Yes";
  if (key === "__usCitizen")         return profile.workAuthorization === "US Citizen" ? "Yes" : "No";
  if (key === "__gradDate")          return `${profile.graduationMonth || "May"} ${profile.graduationYear || "2027"}`;
  if (key === "__referralSource")    return profile.referralSource || "LinkedIn";
  if (key === "__startDate")         return profile.availableStartDate || "June 2026";
  const val = profile[key];
  if (val === undefined || val === null) return null;
  return String(val);
}

// Look up a profile value given a form field's label text.
// Returns null if no match is found (triggers Claude overlay).
function lookupProfileValue(labelText, profile) {
  const lower = (labelText || "").toLowerCase().trim();
  for (const entry of FIELD_MAP) {
    // Skip entries with a maxLabelLength guard if the label is too long
    if (entry.maxLabelLength && lower.length > entry.maxLabelLength) continue;
    if (entry.patterns.some((p) => lower.includes(p))) {
      return resolveProfileValue(entry.key, profile);
    }
  }
  return null;
}

// Look up a saved answer from the Q&A answers DB.
// answersEntries: array from chrome.storage.local 'answers' key.
// Returns the answer string, or null if no match.
function lookupFromAnswers(labelText, answersEntries) {
  if (!answersEntries || !answersEntries.length || !labelText) return null;
  const lower = (labelText || '').toLowerCase().trim();
  for (const entry of answersEntries) {
    if ((entry.patterns || []).some(p => lower.includes(p.toLowerCase()))) {
      return entry.answer || null;
    }
  }
  return null;
}
