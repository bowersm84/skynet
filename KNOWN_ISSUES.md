# SkyNet MES - Known Issues & Technical Debt

**Last Updated:** January 12, 2026

## 🔴 CRITICAL - RLS Performance Issue on Profiles Table

**Status:** WORKAROUND IN PLACE  
**Priority:** HIGH - Must fix before production  
**Date Identified:** January 12, 2026

### Issue Description
The `profiles` table has Row Level Security (RLS) enabled, but profile queries are taking 10+ seconds to complete, causing the application to hang during initialization.

### Current Workaround
**RLS has been DISABLED on the profiles table for development:**
```sql
ALTER TABLE profiles DISABLE ROW LEVEL SECURITY;
```

⚠️ **WARNING**: This is a development-only workaround. RLS MUST be re-enabled and optimized before production deployment.

### Root Cause
Unknown - requires investigation. Possible causes:
- Missing index on profiles.id
- Inefficient RLS policy
- Supabase connection/networking issue
- Database performance problem

### Proper Fix Required
Before production, investigate and implement one of these solutions:

1. **Optimize RLS Policy:**
   ```sql
   ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
   
   CREATE POLICY "Users can view own profile"
     ON profiles FOR SELECT
     TO authenticated
     USING (auth.uid() = id);
   
   -- May need additional policies for admin access
   ```

2. **Add Performance Indexes:**
   ```sql
   -- Verify index exists on profiles.id
   CREATE INDEX IF NOT EXISTS idx_profiles_id ON profiles(id);
   ```

3. **Investigate Query Performance:**
   ```sql
   EXPLAIN ANALYZE
   SELECT * FROM profiles WHERE id = auth.uid();
   ```

### Testing Checklist Before Production
- [ ] Re-enable RLS on profiles table
- [ ] Verify profile queries complete in < 500ms
- [ ] Test with multiple concurrent users
- [ ] Verify admin users can manage other profiles
- [ ] Load test profile queries under production load
- [ ] Remove timeout fallback from App.jsx (or reduce timeout to 2s)

### Related Code
- `src/App.jsx` - fetchProfile function (has 10s timeout fallback)
- `src/lib/supabase.js` - Supabase client configuration

### References
- Supabase RLS Documentation: https://supabase.com/docs/guides/auth/row-level-security
- PostgreSQL RLS Performance: https://www.postgresql.org/docs/current/ddl-rowsecurity.html

---

## Other Issues

### None Currently

---

## Technical Debt Items

### None Currently

---

**Note:** This document should be reviewed and updated regularly. All critical issues must be resolved before production deployment.