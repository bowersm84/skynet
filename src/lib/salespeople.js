import { supabase } from './supabase'

export async function loadActiveSalespeople() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name')
    .eq('is_salesperson', true)
    .eq('is_active', true)
    .order('full_name')
  if (error) {
    console.error('Failed to load salespeople:', error)
    return []
  }
  return data || []
}
