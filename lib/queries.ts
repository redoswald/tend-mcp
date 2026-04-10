/**
 * Shared Supabase query helpers used by MCP tools.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { calculateContactStatus, type ContactStatus } from "./cadence";
import { formatDateForOutput } from "./dates";

interface ContactFilters {
  search?: string;
  tag?: string;
  stage?: string;
  metroArea?: string;
  includeArchived?: boolean;
  limit?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function fetchContactsWithMeta(
  supabase: SupabaseClient,
  userId: string,
  filters: ContactFilters = {}
) {
  let query = supabase
    .from("Contact")
    .select("*, ContactTag(tagId, Tag:tagId(id, name, color)), ContactOOOPeriod(*)")
    .eq("userId", userId)
    .eq("isSelf", false);

  if (!filters.includeArchived) {
    query = query.eq("isArchived", false);
  }

  if (filters.stage) {
    query = query.eq("funnelStage", filters.stage);
  }

  if (filters.metroArea) {
    query = query.ilike("metroArea", `%${filters.metroArea}%`);
  }

  if (filters.search) {
    query = query.or(
      `name.ilike.%${filters.search}%,nickname.ilike.%${filters.search}%`
    );
  }

  query = query.order("name");

  if (filters.limit) {
    query = query.limit(filters.limit);
  }

  const { data, error } = await query;
  if (error) throw error;

  let contacts = data || [];

  // Filter by tag name (post-query since it's a joined table)
  if (filters.tag) {
    const tagLower = filters.tag.toLowerCase();
    contacts = contacts.filter((c: any) =>
      (c.ContactTag || []).some(
        (ct: any) => ct.Tag && ct.Tag.name.toLowerCase() === tagLower
      )
    );
  }

  return contacts;
}

interface EventInfo {
  id: string;
  title: string | null;
  date: string;
  eventType: string;
  location: string | null;
}

export async function fetchLatestEventsForContacts(
  supabase: SupabaseClient,
  userId: string,
  contactIds: string[]
): Promise<Map<string, EventInfo>> {
  if (contactIds.length === 0) return new Map();

  const now = new Date().toISOString();

  const { data: eventContacts } = await supabase
    .from("EventContact")
    .select("contactId, event:eventId(id, title, date, eventType, location, userId)")
    .in("contactId", contactIds)
    .order("event(date)", { ascending: false });

  const result = new Map<string, EventInfo>();

  for (const ec of eventContacts || []) {
    const event = ec.event as any;
    if (!event || event.userId !== userId) continue;
    if (new Date(event.date) > new Date(now)) continue;
    if (result.has(ec.contactId)) continue;
    result.set(ec.contactId, {
      id: event.id,
      title: event.title,
      date: event.date,
      eventType: event.eventType,
      location: event.location,
    });
  }

  return result;
}

export async function fetchNextEventsForContacts(
  supabase: SupabaseClient,
  userId: string,
  contactIds: string[]
): Promise<Map<string, EventInfo>> {
  if (contactIds.length === 0) return new Map();

  const now = new Date().toISOString();

  const { data: eventContacts } = await supabase
    .from("EventContact")
    .select("contactId, event:eventId(id, title, date, eventType, location, userId)")
    .in("contactId", contactIds)
    .order("event(date)", { ascending: true });

  const result = new Map<string, EventInfo>();

  for (const ec of eventContacts || []) {
    const event = ec.event as any;
    if (!event || event.userId !== userId) continue;
    if (new Date(event.date) <= new Date(now)) continue;
    if (result.has(ec.contactId)) continue;
    result.set(ec.contactId, {
      id: event.id,
      title: event.title,
      date: event.date,
      eventType: event.eventType,
      location: event.location,
    });
  }

  return result;
}

export interface EnrichedContact {
  id: string;
  name: string;
  nickname?: string | null;
  notes?: string | null;
  cadenceDays?: number | null;
  funnelStage: string;
  metroArea?: string | null;
  location?: string | null;
  relationship?: string | null;
  ContactOOOPeriod?: any[];
  ContactTag?: any[];
  status: ContactStatus;
  lastEvent: EventInfo | null;
  [key: string]: any;
}

export function computeContactStatuses(
  contacts: any[],
  latestEventsMap: Map<string, EventInfo>,
  nextEventsMap: Map<string, EventInfo>
): EnrichedContact[] {
  return contacts.map((contact) => {
    const lastEvent = latestEventsMap.get(contact.id);
    const nextEvent = nextEventsMap.get(contact.id);
    const oooPeriods = contact.ContactOOOPeriod || [];

    const status = calculateContactStatus(
      lastEvent?.date ? new Date(lastEvent.date) : null,
      contact.cadenceDays,
      nextEvent?.date ? new Date(nextEvent.date) : null,
      oooPeriods
    );

    return { ...contact, status, lastEvent: lastEvent || null };
  });
}

export async function fetchSelfContact(supabase: SupabaseClient, userId: string) {
  const { data } = await supabase
    .from("Contact")
    .select("id, name, ContactOOOPeriod(*)")
    .eq("userId", userId)
    .eq("isSelf", true)
    .single();

  return data;
}

export function formatContactTags(contact: any): string[] {
  return (contact.ContactTag || [])
    .map((ct: any) => ct.Tag?.name)
    .filter(Boolean);
}

export function buildOOOStatus(oooPeriods: any[] | null | undefined) {
  if (!oooPeriods || oooPeriods.length === 0) return null;

  const now = new Date();
  const current = oooPeriods.find(
    (p: any) => new Date(p.startDate) <= now && new Date(p.endDate) >= now
  );

  if (!current) {
    const upcoming = oooPeriods.find((p: any) => new Date(p.startDate) > now);
    if (!upcoming) return null;
    return {
      status: "upcoming",
      label: upcoming.label,
      destination: upcoming.destination,
      startDate: formatDateForOutput(upcoming.startDate),
      returnDate: formatDateForOutput(upcoming.endDate),
    };
  }

  return {
    status: "away",
    label: current.label,
    destination: current.destination,
    returnDate: formatDateForOutput(current.endDate),
  };
}
