# Trial branch small jobs v1

Target branch: `Trial-branch` only.

This pack adds three contained test features:

1. Lower-case email normalisation during sign-up/sign-in.
2. Coach Management: **Decline** alongside Approve, using a reversible `rejected` profile state rather than deleting the Auth user.
3. Coach Player Hub: **Drafts** area listing the signed-in coach's own unfinished feedback and allowing **Continue Draft**.

## Important
Two isolated trial Edge Functions have already been deployed for this test build:

- `approve-coach-trial`
- `player-feedback-trial`

They do not replace the current production functions. The Trial branch is pointed at them through two optional config overrides.

Apply the text changes in the numbered files in this pack to `Trial-branch`, not `main`.

After applying, test:
- email with mixed uppercase/lowercase
- pending coach Approve
- pending coach Decline
- declined coach attempts to sign in
- save a feedback draft
- Player Hub -> Drafts
- Continue Draft
- save the same draft again
- publish it and confirm it disappears from Drafts
