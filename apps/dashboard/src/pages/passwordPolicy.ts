// Password rule shared by the setup page and Settings → Change password (kept apart from AuthPages, which pulls in the
// Dashboard shell's navigation, so pages reused by the Mini App's administration area do not load it).
export const MIN_PASSWORD = 10;
