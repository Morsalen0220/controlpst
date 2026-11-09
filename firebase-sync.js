const fs = require("fs");
const path = require("path");

function createFirebaseSync({ db, admin, uploadsDir }) {
  let dbRef = null;

  function getRootRef() {
    if (!dbRef) {
      if (!admin.apps || !admin.apps.length) return null;
      dbRef = admin.database().ref("appData");
    }
    return dbRef;
  }

  async function restoreAllFromFirebase() {
    const root = getRootRef();
    if (!root) {
      console.log("[Firebase Sync] Firebase not configured; skipping cloud restore.");
      return true;
    }
    try {
      console.log("[Firebase Sync] Checking for cloud backup in Firebase Realtime Database...");
      const snapshot = await root.get();
      if (!snapshot.exists()) {
        console.log("[Firebase Sync] No cloud backup found in Firebase yet. Backing up existing local data if any...");
        await backupLocalToFirebase();
        return true;
      }
      const data = snapshot.val() || {};

      // 0. Restore account labels
      if (data.accounts) {
        const insertAccount = db.prepare("INSERT OR REPLACE INTO accounts (id, label, phone, updated_at) VALUES (@id, @label, @phone, @updated_at)");
        db.transaction((items) => {
          for (const a of items) insertAccount.run({ id: a.id, label: a.label || "", phone: a.phone || "", updated_at: a.updated_at || new Date().toISOString() });
        })(Object.values(data.accounts));
      }

      // 1. Restore Groups
      if (data.groups) {
        const insertGroup = db.prepare(`
          INSERT OR REPLACE INTO groups (id, account_id, username, title, added_at)
          VALUES (@id, @account_id, @username, @title, @added_at)
        `);
        const groupList = Object.values(data.groups);
        db.transaction((items) => {
          for (const g of items) {
            insertGroup.run({
              id: g.id,
              account_id: Number(g.account_id || 1),
              username: g.username,
              title: g.title || g.username,
              added_at: g.added_at || new Date().toISOString()
            });
          }
        })(groupList);
        console.log(`[Firebase Sync] Restored ${groupList.length} groups from Firebase.`);
      }

      // 2. Restore Posts & Media
      if (data.posts) {
        const insertPost = db.prepare(`
          INSERT OR REPLACE INTO posts (id, group_id, text, media_path, schedule_at, interval_minutes, next_run_at, active, created_at)
          VALUES (@id, @group_id, @text, @media_path, @schedule_at, @interval_minutes, @next_run_at, @active, @created_at)
        `);
        const postList = Object.values(data.posts);
        db.transaction((items) => {
          for (const p of items) {
            let localMediaPath = p.media_path || null;
            if (p.media_base64) {
              const filename = p.media_filename || `restored_${p.id}.jpg`;
              localMediaPath = path.join(uploadsDir, filename);
              try {
                fs.mkdirSync(uploadsDir, { recursive: true });
                if (!fs.existsSync(localMediaPath)) {
                  fs.writeFileSync(localMediaPath, Buffer.from(p.media_base64, "base64"));
                }
              } catch (err) {
                console.warn("[Firebase Sync] Error restoring image file:", err.message);
              }
            }
            insertPost.run({
              id: p.id,
              group_id: p.group_id,
              text: p.text || "",
              media_path: localMediaPath,
              schedule_at: p.schedule_at,
              interval_minutes: Number(p.interval_minutes || 0),
              next_run_at: p.next_run_at,
              active: Number(p.active ?? 1),
              created_at: p.created_at || new Date().toISOString()
            });
          }
        })(postList);
        console.log(`[Firebase Sync] Restored ${postList.length} scheduled posts from Firebase.`);
      }

      // 3. Restore History
      if (data.history) {
        const insertHistory = db.prepare(`
          INSERT OR REPLACE INTO history (id, post_id, group_name, result, detail, posted_at)
          VALUES (@id, @post_id, @group_name, @result, @detail, @posted_at)
        `);
        const histList = Object.values(data.history);
        db.transaction((items) => {
          for (const h of items) {
            insertHistory.run({
              id: h.id,
              post_id: h.post_id || null,
              group_name: h.group_name || "",
              result: h.result || "SUCCESS",
              detail: h.detail || "",
              posted_at: h.posted_at || new Date().toISOString()
            });
          }
        })(histList);
        console.log(`[Firebase Sync] Restored ${histList.length} history records from Firebase.`);
      }
      return true;
    } catch (e) {
      console.error("[Firebase Sync] Restore failed:", e.message);
      return false;
    }
  }

  async function backupLocalToFirebase() {
    const root = getRootRef();
    if (!root) return;
    try {
      const groups = db.prepare("SELECT * FROM groups").all();
      const accounts = db.prepare("SELECT * FROM accounts").all();
      await Promise.all(accounts.map(a => syncAccount(a)));
      const posts = db.prepare("SELECT * FROM posts").all();
      const history = db.prepare("SELECT * FROM history").all();
      if (!groups.length && !posts.length && !history.length) return true;
      console.log(`[Firebase Sync] Backing up local data (${groups.length} groups, ${posts.length} posts) to Firebase...`);
      await Promise.all([...groups.map(g => syncGroup(g)), ...posts.map(p => syncPost(p))]);
      await Promise.all(history.map(item => syncHistory(item)));
      return true;
    } catch (err) {
      console.warn("[Firebase Sync] Local backup error:", err.message);
      return false;
    }
  }

  function syncAccount(account) {
    const root = getRootRef();
    if (!root || !account || !account.id) return;
    return root.child(`accounts/${account.id}`).set({
      id: account.id,
      label: account.label || "",
      phone: account.phone || "",
      updated_at: account.updated_at || new Date().toISOString()
    }).catch(err => console.error("[Firebase Sync] Error syncing account:", err.message));
  }

  function syncGroup(group) {
    const root = getRootRef();
    if (!root || !group || !group.id) return;
    return root.child(`groups/${group.id}`).set({
      id: group.id,
      account_id: Number(group.account_id || 1),
      username: group.username,
      title: group.title || group.username,
      added_at: group.added_at || new Date().toISOString()
    });
  }

  function deleteGroup(id) {
    const root = getRootRef();
    if (!root || !id) return;
    root.child(`groups/${id}`).remove().catch(err => {
      console.error("[Firebase Sync] Error deleting group:", err.message);
    });
    // Remove posts belonging to this group from Firebase
    root.child("posts").orderByChild("group_id").equalTo(Number(id)).once("value", snapshot => {
      if (snapshot.exists()) {
        snapshot.forEach(child => {
          child.ref.remove();
        });
      }
    }).catch(() => {});
  }

  function syncPost(post) {
    const root = getRootRef();
    if (!root || !post || !post.id) return;
    let mediaBase64 = null;
    let mediaFilename = null;
    if (post.media_path && fs.existsSync(post.media_path)) {
      try {
        const stat = fs.statSync(post.media_path);
        if (stat.size <= 8 * 1024 * 1024) {
          mediaBase64 = fs.readFileSync(post.media_path).toString("base64");
          mediaFilename = path.basename(post.media_path);
        }
      } catch (err) {
        console.warn("[Firebase Sync] Could not read media file for backup:", err.message);
      }
    }
    const payload = {
      id: post.id,
      group_id: post.group_id,
      text: post.text || "",
      media_path: post.media_path || null,
      media_filename: mediaFilename,
      media_base64: mediaBase64,
      schedule_at: post.schedule_at,
      interval_minutes: Number(post.interval_minutes || 0),
      next_run_at: post.next_run_at,
      active: Number(post.active ?? 1),
      created_at: post.created_at || new Date().toISOString()
    };
    return root.child(`posts/${post.id}`).set(payload).catch(err => {
      console.error("[Firebase Sync] Error syncing post:", err.message);
    });
  }

  function syncPostField(id, field, value) {
    const root = getRootRef();
    if (!root || !id) return;
    return root.child(`posts/${id}/${field}`).set(value).catch(err => {
      console.error(`[Firebase Sync] Error syncing post ${field}:`, err.message);
    });
  }

  function deletePost(id) {
    const root = getRootRef();
    if (!root || !id) return;
    root.child(`posts/${id}`).remove().catch(err => {
      console.error("[Firebase Sync] Error deleting post:", err.message);
    });
  }

  function syncHistory(item) {
    const root = getRootRef();
    if (!root || !item || !item.id) return;
    return root.child(`history/${item.id}`).set({
      id: item.id,
      post_id: item.post_id || null,
      group_name: item.group_name || "",
      result: item.result || "SUCCESS",
      detail: item.detail || "",
      posted_at: item.posted_at || new Date().toISOString()
    }).catch(err => {
      console.error("[Firebase Sync] Error syncing history:", err.message);
    });
  }

  function syncAllPostsActive(active) {
    const root = getRootRef();
    if (!root) return;
    try {
      const posts = db.prepare("SELECT id FROM posts").all();
      for (const p of posts) {
        syncPostField(p.id, "active", active);
      }
    } catch (_) {}
  }

  return {
    restoreAllFromFirebase,
    syncAccount,
    syncGroup,
    deleteGroup,
    syncPost,
    syncPostField,
    deletePost,
    syncHistory,
    syncAllPostsActive
  };
}

module.exports = { createFirebaseSync };

