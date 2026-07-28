import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { Bell, Loader2, CheckCheck } from 'lucide-react'

/**
 * Header notifications bell (D-NOTIF-01). Backed by user_notifications, which
 * is a generic per-user primitive — this component knows nothing about who
 * produced a row beyond an optional payload.co_number deep link.
 *
 * RLS scopes reads to the recipient; the explicit recipient_id filter here
 * mirrors that so the realtime subscription and the query agree.
 */

const LIST_LIMIT = 20

function relativeTime(value) {
  if (!value) return ''
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return ''
  const secs = Math.floor((Date.now() - then) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function NotificationsBell({ profile, onNavigate }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const menuRef = useRef(null)

  const userId = profile?.id || null
  // Deep links only make sense for users who actually have the My Orders view.
  const canDeepLinkToMyOrders = profile?.is_salesperson === true

  const load = useCallback(async () => {
    if (!userId) return
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('user_notifications')
        .select('*')
        .eq('recipient_id', userId)
        .order('created_at', { ascending: false })
        .limit(LIST_LIMIT)
      if (error) throw error
      setRows(data || [])

      // Unread count spans every row, not just the newest page.
      const { count, error: cErr } = await supabase
        .from('user_notifications')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_id', userId)
        .is('read_at', null)
      if (cErr) throw cErr
      setUnreadCount(count || 0)
    } catch (err) {
      console.error('Failed to load notifications:', err)
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => { load() }, [load])

  // Realtime: new rows for this recipient bump the badge without a refetch.
  useEffect(() => {
    if (!userId) return
    const channel = supabase
      .channel(`user-notifications-${userId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'user_notifications',
          filter: `recipient_id=eq.${userId}`,
        },
        (payload) => {
          const row = payload.new
          if (!row) return
          setRows(prev => [row, ...prev.filter(r => r.id !== row.id)].slice(0, LIST_LIMIT))
          if (!row.read_at) setUnreadCount(prev => prev + 1)
        },
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [userId])

  // Close on outside click, matching the other header dropdowns.
  useEffect(() => {
    const handleMouseDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [])

  const markRead = async (row) => {
    if (row.read_at) return
    const now = new Date().toISOString()
    setRows(prev => prev.map(r => (r.id === row.id ? { ...r, read_at: now } : r)))
    setUnreadCount(prev => Math.max(0, prev - 1))
    const { error } = await supabase
      .from('user_notifications')
      .update({ read_at: now })
      .eq('id', row.id)
    if (error) {
      console.error('Failed to mark notification read:', error)
      await load() // put the optimistic update back in sync with the server
    }
  }

  const handleClick = async (row) => {
    await markRead(row)
    const coNumber = row?.payload?.co_number
    if (coNumber && canDeepLinkToMyOrders && onNavigate) {
      setOpen(false)
      // Two-argument navigation — App.jsx routes this through handleNavigate,
      // which carries the payload (D-NAV-01).
      onNavigate('customer_orders', { myOrdersCO: coNumber })
    }
  }

  const markAllRead = async () => {
    if (!userId || unreadCount === 0) return
    const now = new Date().toISOString()
    setRows(prev => prev.map(r => (r.read_at ? r : { ...r, read_at: now })))
    setUnreadCount(0)
    const { error } = await supabase
      .from('user_notifications')
      .update({ read_at: now })
      .eq('recipient_id', userId)
      .is('read_at', null)
    if (error) {
      console.error('Failed to mark all notifications read:', error)
      await load()
    }
  }

  if (!userId) return null

  const badge = unreadCount > 9 ? '9+' : String(unreadCount)

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) load()
        }}
        className="relative flex items-center px-3 py-2 rounded text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-red-600 text-white text-[10px] font-bold leading-none">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-80 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50">
          <div className="px-3 py-2 border-b border-gray-700 flex items-center justify-between">
            <span className="text-sm font-medium text-white">Notifications</span>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs text-gray-400 hover:text-white flex items-center gap-1"
              >
                <CheckCheck size={12} /> Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading && rows.length === 0 ? (
              <div className="px-3 py-6 text-xs text-gray-500 flex items-center justify-center gap-2">
                <Loader2 size={12} className="animate-spin" /> Loading…
              </div>
            ) : rows.length === 0 ? (
              <div className="px-3 py-6 text-xs text-gray-500 text-center">
                No notifications.
              </div>
            ) : (
              rows.map(row => {
                const isUnread = !row.read_at
                return (
                  <button
                    key={row.id}
                    onClick={() => handleClick(row)}
                    className={`w-full text-left px-3 py-2 border-b border-gray-700/60 last:border-b-0 transition-colors ${
                      isUnread ? 'bg-gray-700/40 hover:bg-gray-700/60' : 'hover:bg-gray-700/30'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {isUnread && (
                        <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-skynet-accent flex-shrink-0" />
                      )}
                      <div className={`min-w-0 ${isUnread ? '' : 'pl-3.5'}`}>
                        <div className={`text-xs ${isUnread ? 'text-white font-medium' : 'text-gray-300'}`}>
                          {row.title || 'Notification'}
                        </div>
                        {row.body && (
                          <div className="text-xs text-gray-400 mt-0.5 whitespace-pre-wrap">{row.body}</div>
                        )}
                        <div className="text-[10px] text-gray-500 mt-0.5">
                          {relativeTime(row.created_at)}
                        </div>
                      </div>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
