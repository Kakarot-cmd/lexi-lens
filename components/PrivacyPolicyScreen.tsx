/**
 * PrivacyPolicyScreen.tsx
 * Lexi-Lens — Phase 4.1 COPPA + GDPR-K Compliance
 *
 * A complete, plain-English privacy policy meeting:
 *   • COPPA §312.4 (public notice on the website / in the app)
 *   • GDPR-K Art. 13/14 (transparency notice for data subjects)
 *   • Google Play "Designed for Families" disclosure requirements
 *   • Apple App Store Kids Category review guidelines §5.1.4
 *
 * Rendered as a full-screen view, navigated to from:
 *   • AuthScreen   — "Privacy Policy" link in sign-up legal text
 *   • ConsentGateModal — "Read Privacy Policy →" checkbox link
 *   • ParentDashboard  — Settings section
 *
 * ⚠️  LEGAL NOTE: This is a technical template.
 *     Have a qualified solicitor/attorney review before going live.
 *
 * Policy version: 1.0  (matches CURRENT_POLICY_VERSION in ConsentGateModal)
 * Effective date: 2025-04-28
 */

import React from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Platform,
  Linking,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

// ─── Palette ──────────────────────────────────────────────────────────────────

const P = {
  cream:        "#fdf8f0",
  parchment:    "#f5edda",
  warmBorder:   "#e2d0b0",
  inkBrown:     "#3d2a0f",
  inkMid:       "#6b4c1e",
  inkLight:     "#9c7540",
  inkFaint:     "#c4a97a",
  amber:        "#d97706",
  amberLight:   "#fef3c7",
  amberBorder:  "#fde68a",
  errorText:    "#9f1239",
  white:        "#ffffff",
} as const;

// ─── Policy section data ──────────────────────────────────────────────────────

interface PolicySection {
  id:    string;
  emoji: string;
  title: string;
  body:  string;
}

const SECTIONS: PolicySection[] = [
  {
    id:    "who",
    emoji: "👋",
    title: "Who we are",
    body: `Lexi-Lens is an augmented-reality vocabulary game built for children aged 5–12. The app is operated by the Lexi-Lens developer team ("we", "us", "our").

We take children's privacy very seriously. We comply fully with the Children's Online Privacy Protection Act (COPPA), the provisions of the EU General Data Protection Regulation that apply to children (GDPR-K), and the requirements of the Google Play "Designed for Families" programme and Apple App Store Kids category.

Contact for privacy matters: privacy@lexi-lens.app
Last updated: April 2025  |  Policy version: 1.0`,
  },
  {
    id:    "collect",
    emoji: "📊",
    title: "What information we collect",
    body: `FOR PARENTS (the account holder):
• Email address — required to create and log in to an account, and to send account-related emails such as password resets and deletion confirmations.
• Display name — shown on the parent dashboard. Optional; can be a nickname.
• Password — stored as a one-way bcrypt hash by Supabase Auth. We cannot read it.
• Parental consent record — timestamp, IP address hash (not the IP itself), and the version of the policy consented to. Stored for legal compliance.

FOR CHILDREN (profiles added by the parent):
• Display name (first name or nickname only) — chosen by the parent. Shown in the app to greet the child. Never shared with third parties.
• Age band (e.g. "7–8 years") — used to select age-appropriate vocabulary difficulty. This is NOT a date of birth and is not a precise age.
• Avatar selection (wizard, knight, archer, or dragon emoji) — stored as a text key.

GAMEPLAY DATA:
• Words scanned (the object label detected by the camera, e.g. "apple").
• XP points awarded per scan.
• Quest completion status.
• Scan attempt logs: the detected object label, camera confidence score, Claude AI verdict, and timestamp. Camera frames are never stored — they are processed on-device and immediately discarded.

WHAT WE ABSOLUTELY DO NOT COLLECT FOR CHILDREN:
• Email address or username
• Date of birth or exact age
• Device advertising identifiers (IDFA, GAID, Android ID)
• Location data (GPS coordinates, city, or IP-derived location)
• Photographs, video, or any visual media
• Biometric data
• Behavioural advertising profiles
• Social graph data or information from other apps`,
  },
  {
    id:    "use",
    emoji: "🔧",
    title: "How we use the information",
    body: `PARENT DATA is used exclusively to:
• Authenticate the parent's account securely.
• Display the parent dashboard with their children's progress reports.
• Send essential account emails (confirmation, password reset, deletion confirmation).
• Maintain a record of parental consent to demonstrate regulatory compliance.

CHILD DATA is used exclusively to:
• Display the child's name and selected avatar within the app.
• Determine which vocabulary quests are age-appropriate.
• Calculate XP and track word mastery in the Word Tome.
• Generate the parent's progress dashboard.

SCAN ATTEMPT LOGS are used to:
• Show vocabulary history in the Word Tome.
• Power the weekly progress reports in the Parent Dashboard.
• Improve AI evaluation quality through anonymised aggregate analysis only — no child identity is attached to any aggregate analysis.

WE DO NOT USE DATA FOR:
• Serving behavioural advertisements
• Building advertising profiles on children or parents
• Selling, licensing, or sharing with data brokers
• Training AI models (scan logs are never used to retrain Claude)
• Any commercial purpose beyond operating the vocabulary game`,
  },
  {
    id:    "ai",
    emoji: "🤖",
    title: "How Claude AI is used",
    body: `When a child scans an object with the camera, our app uses Google ML Kit Vision to detect an object label entirely on-device (e.g. "apple"). This label — and only this label — is then sent to Anthropic's Claude AI API to check whether it matches the vocabulary quest target.

WHAT IS SENT TO CLAUDE AI:
• The detected object label (a single word or short phrase, e.g. "apple")
• The quest target word and its vocabulary properties (e.g. "fruit, red, round")
• The child's age band — used to calibrate the difficulty of feedback language (e.g. "7–8 years")

WHAT IS NEVER SENT TO CLAUDE AI:
• Any image or photo
• The child's name, exact age, or any personal identifier
• The parent's email address or any account information
• Device identifiers or location

Claude's response (a structured JSON verdict) is returned immediately and displayed to the child. Anthropic processes API requests under their own privacy policy (anthropic.com/privacy). Object labels submitted via the API are not used by Anthropic to train future models under the terms of the API agreement.`,
  },
  {
    id:    "sharing",
    emoji: "🤝",
    title: "Who we share data with",
    body: `We share data with the following service providers only, and only to the minimum extent necessary to operate the app:

SUPABASE (supabase.com)
Role: Database, authentication, and Edge Functions (serverless backend).
Data shared: Parent account data, child profile data, gameplay logs.
Location: Stored in EU-West-1 (Ireland). Supabase is fully GDPR-compliant.
Agreement: A Data Processing Agreement (DPA) is in place with Supabase.

ANTHROPIC (anthropic.com)
Role: Claude AI model for vocabulary evaluation.
Data shared: Object labels only (a single word per scan). No PII of any kind.
Agreement: Governed by Anthropic's API Terms of Service and Privacy Policy.

EXPO / EAS (expo.dev)
Role: App build infrastructure and over-the-air updates.
Data shared: No user data. EAS receives only the compiled app binary.
Agreement: Expo's standard Terms of Service apply.

WE DO NOT SHARE DATA WITH:
• Advertising networks (no ads in the app at all)
• Data brokers or analytics aggregators
• Social media platforms
• Any other third parties
• Law enforcement, except where legally compelled — and we will notify parents where legally permitted if this occurs`,
  },
  {
    id:    "retention",
    emoji: "📅",
    title: "How long we keep data",
    body: `PARENT ACCOUNT DATA: Retained for the lifetime of the account. Permanently deleted within 30 days of an account deletion request via the in-app Delete Account flow or by emailing privacy@lexi-lens.app.

CHILD PROFILE DATA (name, age band, avatar): Deleted immediately when a parent removes the child profile. Deleted within 24 hours of an account deletion request.

SCAN ATTEMPT LOGS: Retained for 12 months from the scan date to power the Parent Dashboard reports, then automatically purged. Can be deleted sooner by deleting the child profile or the parent account.

PARENTAL CONSENT RECORDS: Retained for 7 years from the consent date. This retention period is required by law (COPPA audit trail / GDPR accountability principle). These records do not contain child data — only the timestamp, policy version, and an anonymous hash of the IP address.

DATA DELETION REQUEST RECORDS: Retained for 7 years as evidence that we processed the deletion promptly. Contain only the request timestamp and completion date — no account content.`,
  },
  {
    id:    "rights",
    emoji: "⚖️",
    title: "Your rights as a parent",
    body: `UNDER COPPA (US PARENTS), you have the right to:
• Review the personal information we have collected from your child at any time.
• Refuse to permit further collection or use of your child's personal information.
• Request that we delete your child's personal information — we will do so within 30 days.
• Consent to collection of your child's data without also consenting to disclosure to third parties (which we don't do anyway).

UNDER GDPR (EU/UK PARENTS), you also have the right to:
• Access: Receive a copy of all data we hold about you and your child.
• Rectification: Correct any inaccurate information.
• Erasure ("right to be forgotten"): Request deletion of all data.
• Restriction: Ask us to stop processing data while a dispute is resolved.
• Portability: Receive your data in a machine-readable format (JSON export).
• Objection: Object to processing based on legitimate interests.
• Withdraw consent: At any time — withdrawal requires account deletion.
• Complain: Lodge a complaint with your national data protection authority (e.g. ICO in the UK, CNIL in France, DPC in Ireland).

HOW TO EXERCISE YOUR RIGHTS:
• In-app: Parent Dashboard → Settings → Delete Account (for full deletion)
• By email: privacy@lexi-lens.app (for access, portability, or other requests)
• We will respond within 30 days. For children's data, we will prioritise and aim to respond within 5 business days.`,
  },
  {
    id:    "security",
    emoji: "🔒",
    title: "Security",
    body: `DATA IN TRANSIT: All communication between the app and Supabase is encrypted using TLS 1.3. API requests to Claude are made server-side via Supabase Edge Functions — the Claude API key is never exposed to the mobile app.

DATA AT REST: Supabase stores all data encrypted at rest using AES-256 with keys managed by AWS KMS (EU-West-1).

PASSWORDS: Bcrypt-hashed with a cost factor of 10. We can never read your password.

CAMERA: The camera is used exclusively for real-time object detection via Google ML Kit Vision running entirely on-device. No camera frames, images, or video are transmitted over the network, stored on our servers, or seen by any human.

ROW LEVEL SECURITY: PostgreSQL Row Level Security (RLS) policies ensure that each parent can only read and write their own account and their children's data. There is no way for one parent to access another parent's data via the Supabase client.

EDGE FUNCTION SECURITY: All write operations and AI calls go through authenticated Edge Functions. The mobile app uses an anonymous key that can only read/write data belonging to the authenticated user.

VULNERABILITY DISCLOSURE: If you discover a security issue, please email security@lexi-lens.app. Do not open a public GitHub issue. We will acknowledge within 48 hours and aim to release a fix within 7 days.`,
  },
  {
    id:    "children",
    emoji: "👧🧒",
    title: "Special note on children's data",
    body: `Lexi-Lens is specifically designed for children aged 5–12, which means we apply the strictest possible data practices:

• We do not allow children to create their own accounts. Only a parent or guardian may create an account and add child profiles.

• Children cannot communicate with other users in any way. There is no chat, no user-generated content visible to others, and no social features.

• The app contains no advertising of any kind — paid, free, targeted, or contextual.

• Children's vocabulary data is used only to show their own progress. It is never used to serve content to other users or for any commercial analytics.

• We do not knowingly collect any information from children beyond what is strictly necessary for the educational vocabulary game to function (name, age band, words scanned, XP).

• If we discover we have accidentally collected data from a child under 5 (below our target age), we will delete it immediately. Please contact privacy@lexi-lens.app if you believe this has occurred.`,
  },
  {
    id:    "changes",
    emoji: "📝",
    title: "Changes to this policy",
    body: `If we make material changes to this privacy policy, we will notify you by:
1. Showing a prominent in-app notice the next time you open the app.
2. Sending an email to the address registered on your parent account.
3. Requiring you to re-read and re-confirm consent before you can continue using the app.

Minor changes (correcting typos, clarifying existing practices, updating contact details) may be made without notice, but the version number and "Last updated" date at the top of this page will always change.

You can view the history of all policy versions at lexi-lens.app/privacy/history.

If you do not agree with a material change, you may delete your account at any time via Parent Dashboard → Settings → Delete Account, and all your data will be deleted within 30 days.`,
  },
  {
    id:    "contact",
    emoji: "📬",
    title: "Contact us",
    body: `For any privacy-related question, data access request, or concern about your child's data:

Email: privacy@lexi-lens.app
Response time: Within 30 days (we aim for within 5 business days for children's data requests)

For security vulnerabilities:
Email: security@lexi-lens.app

For urgent child safety concerns, please contact your local child protection authority directly. We cooperate fully with legitimate law enforcement requests.

This privacy policy is governed by the laws of India. For EU/UK residents, we accept the jurisdiction of applicable EU/UK data protection authorities.`,
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  onClose?: () => void;
}

export function PrivacyPolicyScreen({ onClose }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>

      {/* Sticky header */}
      <View style={styles.header}>
        {onClose ? (
          <TouchableOpacity
            style={styles.backBtn}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close privacy policy"
          >
            <Text style={styles.backBtnText}>← Back</Text>
          </TouchableOpacity>
        ) : (
          <View style={{ width: 60 }} />
        )}
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Privacy Policy</Text>
        </View>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={styles.hero}>
          <Text style={styles.heroEmoji}>🛡️</Text>
          <Text style={styles.heroTitle}>Your privacy matters</Text>
          <Text style={styles.heroSub}>Version 1.0 · April 2025</Text>
        </View>

        {/* Plain-English summary banner */}
        <View style={styles.summaryBanner}>
          <Text style={styles.summaryTitle}>📌 Plain-English Summary</Text>
          <Text style={styles.summaryText}>
            We store your email to log you in. For your child, we store only a
            nickname and an age range — nothing else. We never sell data, never
            show ads, and you can delete everything permanently at any time.
          </Text>
        </View>

        {/* Policy sections */}
        {SECTIONS.map((section) => (
          <View key={section.id} style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionEmoji}>{section.emoji}</Text>
              <Text style={styles.sectionTitle}>{section.title}</Text>
            </View>
            <Text style={styles.sectionBody}>{section.body}</Text>
          </View>
        ))}

        {/* Email contact CTA */}
        <TouchableOpacity
          style={styles.emailBtn}
          onPress={() => Linking.openURL("mailto:privacy@lexi-lens.app").catch(() => null)}
          accessibilityRole="link"
          accessibilityLabel="Email privacy@lexi-lens.app"
        >
          <Text style={styles.emailBtnText}>📬  Email  privacy@lexi-lens.app</Text>
        </TouchableOpacity>

        <Text style={styles.footer}>
          This privacy policy is effective as of April 2025 and applies to all
          users of the Lexi-Lens mobile application on iOS and Android.{"\n"}
          Policy version 1.0.
        </Text>
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: P.cream },

  header: {
    flexDirection:     "row",
    alignItems:        "center",
    justifyContent:    "space-between",
    paddingHorizontal: 20,
    paddingVertical:   14,
    borderBottomWidth: 1,
    borderBottomColor: P.warmBorder,
    backgroundColor:   P.cream,
  },
  backBtn:      { width: 60 },
  backBtnText:  { fontSize: 15, color: P.amber, fontWeight: "700" },
  headerCenter: { flex: 1, alignItems: "center" },
  headerTitle:  { fontSize: 17, fontWeight: "700", color: P.inkBrown },

  scroll: { paddingHorizontal: 20, paddingTop: 20 },

  hero:      { alignItems: "center", marginBottom: 24 },
  heroEmoji: { fontSize: 52, marginBottom: 10 },
  heroTitle: { fontSize: 24, fontWeight: "800", color: P.inkBrown, marginBottom: 4 },
  heroSub:   { fontSize: 12, color: P.inkFaint },

  summaryBanner: {
    backgroundColor: P.amberLight,
    borderRadius:    16,
    borderWidth:     1,
    borderColor:     P.amberBorder,
    padding:         18,
    marginBottom:    20,
  },
  summaryTitle: { fontSize: 14, fontWeight: "700", color: P.inkBrown, marginBottom: 8 },
  summaryText:  { fontSize: 14, color: P.inkMid, lineHeight: 21 },

  section: {
    backgroundColor: P.white,
    borderRadius:    16,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    padding:         18,
    marginBottom:    12,
    ...Platform.select({
      ios:     { shadowColor: "#000", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 6 },
      android: { elevation: 1 },
    }),
  },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  sectionEmoji:  { fontSize: 24 },
  sectionTitle:  { fontSize: 16, fontWeight: "700", color: P.inkBrown, flex: 1 },
  sectionBody:   { fontSize: 13, color: P.inkMid, lineHeight: 21 },

  emailBtn: {
    backgroundColor: P.parchment,
    borderRadius:    14,
    borderWidth:     1,
    borderColor:     P.warmBorder,
    padding:         16,
    alignItems:      "center",
    marginTop:       8,
    marginBottom:    16,
  },
  emailBtnText: { fontSize: 14, fontWeight: "700", color: P.amber },

  footer: {
    fontSize:   11,
    color:      P.inkFaint,
    textAlign:  "center",
    lineHeight: 17,
    marginBottom: 8,
  },
});
