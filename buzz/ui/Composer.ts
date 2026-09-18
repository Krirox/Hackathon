// Composer — Message #room with @ 📎 😊 Aa bar + slash-command autocomplete
// Posts to POST /console/buzz/:scope/command (CSRF + audit_log)
// Placeholder: Message #engineering — see src/console/buzz.ts renderBuzzRoom composer block

export const COMPOSER_PLACEHOLDER_PREFIX = "Message #";
export const COMPOSER_COMMANDS = ["/halt", "/recover", "/status", "/cost", "/policy"] as const;
