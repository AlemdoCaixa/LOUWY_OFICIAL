export type View = "home" | "library" | "explore" | "playlists" | "team" | "schedule" | "studio";

export type LyricWord = { text: string; start: number; end: number };
export type LyricLine = { text: string; time: number | null; end?: number; words?: LyricWord[] };

export type Song = {
  id: string;
  title: string;
  artist: string;
  originalKey: string;
  keyMode?: "major" | "minor";
  keyConfidence?: number;
  keySource?: "detected" | "manual";
  stems?: Record<string, string>;
  lyrics?: LyricLine[];
  lyricsModel?: string;
  duration: number;
  cover?: string;
  youtubeUrl?: string;
  audioUrl?: string;
  source?: "youtube" | "upload" | "demo";
  uses?: number;
};

export type LibraryEntry = {
  songId: string;
  preferredShift: number;
  preferredKey?: string;
  preferredInstrument?: string;
  preferredSpeed?: number;
  favorite: boolean;
  folderId?: string;
};

export type PersonalFolder = { id: string; name: string };
export type Playlist = { id: string; name: string; songIds: string[]; public: boolean };
export type UserProfile = { folders: PersonalFolder[]; library: LibraryEntry[]; playlists: Playlist[] };

export type BrandingSettings = {
  productName: "Louwy";
  organizationName: string;
  logoUrl: string;
  logoStoredName?: string;
  accentColor?: string;
};

export type PlanId = "free" | "members10" | "members25" | "unlimited";

export type PlanDefinition = {
  id: PlanId;
  name: string;
  priceCents: number;
  memberLimit: number | null;
};

export type SubscriptionState = {
  planId: PlanId;
  status: "active" | "pending" | "past_due" | "cancelled";
  requestedPlanId?: PlanId | "";
  requestedAt?: string;
  startedAt?: string;
  updatedAt?: string;
  provider?: string;
  payerEmail?: string;
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  requestedProviderSubscriptionId?: string;
  nextPaymentAt?: string;
  lastPaymentAt?: string;
  cancelledAt?: string;
};

export type BillingSummary = {
  subscription: SubscriptionState;
  plan: PlanDefinition;
  members: number;
  memberLimit: number | null;
  remaining: number | null;
  canAddMembers: boolean;
  overLimit: boolean;
};

export type Church = {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type ChurchContext = {
  resolved: boolean;
  requestedSlug: string;
  explicit: boolean;
  rootDomain: string;
  registrationAllowed: boolean;
  church: Church | null;
};

export type MemberRole = "master" | "member";
export type VocalRegister = "high" | "low" | "flex";
export type AttendanceStatus = "pending" | "confirmed" | "unavailable";

export type NotificationType =
  | "event-invitation"
  | "event-update"
  | "event-removed"
  | "repertoire"
  | "message"
  | "file"
  | "mention"
  | "attendance"
  | "team";

export type UserNotification = {
  id: string;
  memberId: string;
  type: NotificationType;
  title: string;
  message: string;
  eventId?: string;
  songId?: string;
  actorId?: string;
  createdAt: string;
  readAt?: string;
};

export type Member = {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  avatarUrl?: string;
  churchId?: string;
  churchSlug?: string;
  churchName?: string;
  role: MemberRole;
  permissions?: string[];
  functions: string[];
  vocalRegister?: VocalRegister;
  active: boolean;
};

export type VocalConfig = { highParts: number; lowParts: number };

export type Team = {
  id: string;
  name: string;
  description?: string;
  color?: string;
  emoji?: string;
  memberIds: string[];
  leaderId?: string;
  vocalConfig: VocalConfig;
  archived?: boolean;
  createdAt: string;
};

export type EventModuleKind =
  | "participants"
  | "confirmations"
  | "repertoire"
  | "vocal-arrangement"
  | "chat"
  | "files";

export type EventModule = {
  id: string;
  kind: EventModuleKind;
  title: string;
  order: number;
};

export type EventParticipant = {
  memberId: string;
  function: string;
  status: AttendanceStatus;
  absenceReason?: string;
  respondedAt?: string;
};

export type VocalPartAssignment = {
  memberId: string;
  register: "high" | "low";
  part: number;
  updatedAt: string;
};

export type EventSongComment = {
  id: string;
  authorId: string;
  text: string;
  taggedMemberIds?: string[];
  createdAt: string;
};

export type EventSong = {
  id: string;
  songId: string;
  submittedBy: string;
  ministerId: string;
  key: string;
  description: string;
  message?: string;
  taggedMemberIds?: string[];
  vocalAssignments: VocalPartAssignment[];
  comments?: EventSongComment[];
  order: number;
  createdAt: string;
};

export type EventMessage = { id: string; authorId: string; text: string; createdAt: string };
export type EventAttachment = {
  id: string;
  title: string;
  originalName?: string;
  storedName?: string;
  mimeType?: string;
  size?: number;
  url?: string;
  authorId: string;
  createdAt: string;
};

export type PublicAgendaEvent = {
  id: string;
  title: string;
  date: string;
  time: string;
  location: string;
  teamId: string;
  teamName: string;
  color?: string;
  emoji?: string;
};

export type MinistryEvent = {
  id: string;
  title: string;
  date: string;
  time: string;
  location?: string;
  description?: string;
  color?: string;
  emoji?: string;
  teamId?: string;
  vocalConfig: VocalConfig;
  createdBy: string;
  modules: EventModule[];
  participants: EventParticipant[];
  songs: EventSong[];
  messages: EventMessage[];
  attachments: EventAttachment[];
  archived?: boolean;
  createdAt: string;
};

export type Workspace = {
  branding: BrandingSettings;
  church?: Church;
  billing?: BillingSummary;
  members: Member[];
  teams: Team[];
  events: MinistryEvent[];
  agenda: PublicAgendaEvent[];
  profiles: Record<string, UserProfile>;
};
