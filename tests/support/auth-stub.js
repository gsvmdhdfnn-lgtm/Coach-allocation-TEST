// Fake supabase-js client for local Playwright testing only.
// Mirrors just the surface app.js actually calls: auth.getSession,
// auth.onAuthStateChange, auth.signUp, auth.signInWithPassword, auth.signOut.
(function () {
  var users = {}; // email -> { password }
  var currentSession = null;
  var listeners = [];
  function fakeUser(email) { return { id: 'uid-' + email, email: email }; }
  // account_type mirrors what a real signUp's options.data reaches the
  // handle_new_user() trigger with - encoded onto the fake token so the
  // mock /me route (which has no real trigger behind it) can honour it.
  function makeSession(email, accountType) { return { access_token: 'tok-' + email + (accountType ? '~' + accountType : ''), refresh_token: 'rt-' + email, user: fakeUser(email) }; }
  function emit(event, session) { listeners.forEach(function (cb) { cb(event, session); }); }

  window.supabase = {
    createClient: function () {
      return {
        auth: {
          getSession: function () { return Promise.resolve({ data: { session: currentSession }, error: null }); },
          onAuthStateChange: function (cb) { listeners.push(cb); return { data: { subscription: { unsubscribe: function () {} } } }; },
          signUp: function (o) {
            if (users[o.email]) return Promise.resolve({ data: { session: null, user: null }, error: { message: 'User already registered' } });
            var accountType = o.options && o.options.data && o.options.data.account_type;
            users[o.email] = { password: o.password, accountType: accountType };
            window.__lastSignUpAccountType = accountType;
            window.__lastSignUpEmailRedirectTo = o.options && o.options.emailRedirectTo;
            var requireConfirm = window.__TEST_REQUIRE_CONFIRM === true;
            var session = requireConfirm ? null : makeSession(o.email, accountType);
            currentSession = session;
            if (session) emit('SIGNED_IN', session);
            return Promise.resolve({ data: { session: session, user: fakeUser(o.email) }, error: null });
          },
          signInWithPassword: function (o) {
            var u = users[o.email];
            if (!u || u.password !== o.password) return Promise.resolve({ data: { session: null, user: null }, error: { message: 'Invalid login credentials' } });
            var session = makeSession(o.email, u.accountType);
            currentSession = session;
            emit('SIGNED_IN', session);
            return Promise.resolve({ data: { session: session, user: fakeUser(o.email) }, error: null });
          },
          signOut: function () {
            currentSession = null;
            emit('SIGNED_OUT', null);
            return Promise.resolve({ error: null });
          }
        }
      };
    }
  };
})();
