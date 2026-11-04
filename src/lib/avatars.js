// lib/avatars.js — assembler avatars (S17 B2, D-ASM-32): an icon name and a hex colour per profile
// (profiles.avatar_icon / avatar_color), set through profile_set_avatar — by the assembler on the kiosk (Batch C);
// the RPC also lets an admin set one, for support, but no page calls it that way. The Assembly Board's columns and
// cards, and the kiosk, draw them with <Avatar> from components/AvatarPicker.
import {
  Wrench, Hammer, Cog, Bolt, Anvil, Drill, Ruler, Gauge, Rocket, Plane, Shield, Star,
  Zap, Flame, Leaf, Mountain, Anchor, Compass, Crown, Diamond, Feather, Flag, Key, Target,
} from 'lucide-react'
import { supabase } from './supabase'

// Stored by name, so the set can be redrawn or extended without touching the data.
export const AVATAR_ICONS = {
  wrench: Wrench, hammer: Hammer, cog: Cog, bolt: Bolt, anvil: Anvil, drill: Drill,
  ruler: Ruler, gauge: Gauge, rocket: Rocket, plane: Plane, shield: Shield, star: Star,
  zap: Zap, flame: Flame, leaf: Leaf, mountain: Mountain, anchor: Anchor, compass: Compass,
  crown: Crown, diamond: Diamond, feather: Feather, flag: Flag, key: Key, target: Target,
}

// The icon is drawn white on the colour; every colour here gives white at least 4.5:1 (lowest: the grey, 4.89).
export const AVATAR_COLORS = [
  { hex: '#B8222E', name: 'Skybolt red' },
  { hex: '#707172', name: 'Skybolt grey' },
  { hex: '#1D4ED8', name: 'Blue' },
  { hex: '#4338CA', name: 'Indigo' },
  { hex: '#7E22CE', name: 'Purple' },
  { hex: '#A21CAF', name: 'Magenta' },
  { hex: '#BE185D', name: 'Pink' },
  { hex: '#C2410C', name: 'Orange' },
  { hex: '#A16207', name: 'Mustard' },
  { hex: '#4D7C0F', name: 'Olive' },
  { hex: '#15803D', name: 'Green' },
  { hex: '#0E7490', name: 'Cyan' },
]
export const DEFAULT_AVATAR_COLOR = '#707172'

// No icon chosen yet: the person's initials stand in.
export function initials(name) {
  const parts = String(name || '').trim().split(/[\s._-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// icon: a key of AVATAR_ICONS or null (initials); color: '#RRGGBB' or null (grey).
export async function setAvatar(profileId, icon, color) {
  const { error } = await supabase.rpc('profile_set_avatar', { p_profile_id: profileId, p_icon: icon || null, p_color: color || null })
  if (error) throw error
}
