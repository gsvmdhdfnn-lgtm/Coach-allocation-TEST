# Trial test checklist

## A. Email normalisation
1. Register/sign in using an email containing uppercase letters.
2. Confirm the account behaves exactly the same when the same email is later typed in lowercase.
3. Confirm the displayed/stored auth email is not treated as a second identity.

## B. Coach decline
1. Create or use a pending test coach.
2. Management -> Coach Management.
3. Confirm both **Approve** and **Decline** appear.
4. Decline the test account.
5. Confirm it disappears from Pending.
6. Sign in as that account.
7. Confirm it receives **Account not approved** and cannot enter Coach Hub.
8. Confirm no Airtable Coach record/player/session data was deleted.

## C. Drafts
1. Coach -> Player Hub -> player -> Add Feedback.
2. Enter at least one rating/text field.
3. Save Draft.
4. Return to Player Hub.
5. Open **Drafts**.
6. Confirm the draft shows the correct player and session.
7. Tap **Continue Draft**.
8. Confirm previous content is restored.
9. Change something and Save Draft again.
10. Reopen it and confirm it is still the SAME draft, not a duplicate.
11. Publish Feedback.
12. Return to Drafts and confirm the published item is gone.
13. Check Parent Hub only sees it after Publish.
