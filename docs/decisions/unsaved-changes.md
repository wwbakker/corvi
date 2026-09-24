# Leaving a page with unsaved edits

Status: accepted and implemented on the settings page.

| Decision | Reason and boundary |
| --- | --- |
| A navigation guard asks before leaving with unsaved edits | Auto-save would write decisions the user never made, and letting the draft go already loses work. Asking does neither. |
| Three answers: Save and leave, Discard and leave, Stay | "Leave without saving" and "I did not mean to leave" are different intentions. Escape is Stay. |
| The page publishes its dirty flag, its save, and the view it guards; the shell owns the history and the URLs | The page alone knows its draft, the shell alone navigates. The prompt's save is the page's own save, so the button and the dialog cannot drift; the URL a held Back puts back is the guarded view's, encoded in one place. |
| Back and Forward are guarded like clicks | Back is the likeliest accidental exit. While the prompt is open the guarded view's URL is pushed back, so the address bar and the page on screen never disagree. |
| Not window close, quit, or reload | That is the host's unload path (`beforeunload` and the host bridge), a different mechanism from in-app navigation. A follow-up change. |

The guard is the shell's generic mechanism (`apps/web/src/app-root/navigation.ts`); the settings
page is its first user, and the dialog lives with the settings it speaks of. A second guarded
page would move the pattern into the shell, not change the rule.
