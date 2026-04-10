import { z } from "zod";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createId } from "@paralleldrive/cuid2";
import { createClient, getUserId } from "@/lib/supabase";
import {
  fetchContactsWithMeta,
  fetchLatestEventsForContacts,
  fetchNextEventsForContacts,
  computeContactStatuses,
  fetchSelfContact,
  formatContactTags,
  buildOOOStatus,
} from "@/lib/queries";
import { formatDateForOutput, parseLocalDateToUTC, todayAtNoonUTC } from "@/lib/dates";
import { daysBetween } from "@/lib/cadence";
import { resolveContactByNameOrId, resolveContactNames } from "@/lib/fuzzy";
import { normalizeMetroArea } from "@/lib/metro";

/* eslint-disable @typescript-eslint/no-explicit-any */

const handler = createMcpHandler(
  (server) => {
    const supabase = createClient();
    const userId = getUserId();

    // ─── get_contacts ───────────────────────────────────────────
    server.tool(
      "get_contacts",
      "Search and list contacts from Tend. Returns contacts with their tags, cadence status, last event date, funnel stage, location, and OOO status. Use when the user asks about their contacts, wants to find someone specific, or asks broad questions about their social circle.",
      {
        search: z.string().optional().describe("Fuzzy match on name or nickname"),
        tag: z.string().optional().describe("Filter by tag name"),
        stage: z.string().optional().describe("Filter by funnel stage"),
        metro_area: z.string().optional().describe("Filter by metro area"),
        overdue_only: z.boolean().optional().describe("Only return overdue contacts"),
        include_archived: z.boolean().optional().describe("Include archived contacts"),
        limit: z.number().optional().describe("Max results (default 25, max 100)"),
      },
      async (params) => {
        const limit = Math.min(params.limit || 25, 100);

        const contacts = await fetchContactsWithMeta(supabase, userId, {
          search: params.search,
          tag: params.tag,
          stage: params.stage,
          metroArea: params.metro_area,
          includeArchived: params.include_archived,
        });

        const contactIds = contacts.map((c: any) => c.id);
        const [latestEvents, nextEvents] = await Promise.all([
          fetchLatestEventsForContacts(supabase, userId, contactIds),
          fetchNextEventsForContacts(supabase, userId, contactIds),
        ]);

        let enriched = computeContactStatuses(contacts, latestEvents, nextEvents);

        if (params.overdue_only) {
          enriched = enriched.filter((c) => c.status.isOverdue);
        }

        enriched.sort((a, b) => {
          const aOverdue = a.status.isOverdue && !a.status.isAway;
          const bOverdue = b.status.isOverdue && !b.status.isAway;
          if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;

          const aDueSoon = (a.status.isDue || a.status.isDueSoon) && !a.status.isAway;
          const bDueSoon = (b.status.isDue || b.status.isDueSoon) && !b.status.isAway;
          if (aDueSoon !== bDueSoon) return aDueSoon ? -1 : 1;

          if (a.status.isAway !== b.status.isAway)
            return a.status.isAway ? 1 : -1;

          return a.name.localeCompare(b.name);
        });

        const results = enriched.slice(0, limit).map((c) => ({
          id: c.id,
          name: c.name,
          nickname: c.nickname,
          notes: c.notes,
          cadenceDays: c.cadenceDays,
          funnelStage: c.funnelStage,
          metroArea: c.metroArea,
          tags: formatContactTags(c),
          lastEventDate: formatDateForOutput(c.lastEvent?.date),
          lastEventTitle: c.lastEvent?.title,
          lastEventLocation: c.lastEvent?.location,
          daysSinceLastEvent: c.status.daysSinceLastEvent,
          daysUntilDue: c.status.daysUntilDue,
          isOverdue: c.status.isOverdue,
          ooo: buildOOOStatus(c.ContactOOOPeriod),
        }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        };
      }
    );

    // ─── get_contact_detail ─────────────────────────────────────
    server.tool(
      "get_contact_detail",
      "Get full details about a specific contact, including their complete event history, tags, action items, cadence status, OOO periods, relationships, and important dates. Use when the user asks about a specific person in depth.",
      {
        contact_id: z.string().optional().describe("Contact ID"),
        name: z.string().optional().describe("Contact name (fuzzy matched)"),
      },
      async (params) => {
        const { contact, warning } = await resolveContactByNameOrId(
          supabase, userId, { contactId: params.contact_id, name: params.name }
        );

        if (!contact) {
          return { content: [{ type: "text" as const, text: warning! }] };
        }

        const { data: tagRows } = await supabase
          .from("ContactTag")
          .select("Tag:tagId(name, color)")
          .eq("contactId", contact.id);

        const { data: oooPeriods } = await supabase
          .from("ContactOOOPeriod")
          .select("*")
          .eq("contactId", contact.id)
          .order("startDate", { ascending: false });

        const { data: rels1 } = await supabase
          .from("ContactRelationship")
          .select("relatedId, relationshipType, RelatedContact:relatedId(name)")
          .eq("contactId", contact.id);

        const { data: rels2 } = await supabase
          .from("ContactRelationship")
          .select("contactId, relationshipType, SourceContact:contactId(name)")
          .eq("relatedId", contact.id);

        const relationships = [
          ...(rels1 || []).map((r: any) => ({
            name: r.RelatedContact?.name,
            type: r.relationshipType,
          })),
          ...(rels2 || []).map((r: any) => ({
            name: r.SourceContact?.name,
            type: r.relationshipType,
          })),
        ];

        const { data: importantDates } = await supabase
          .from("ImportantDate")
          .select("*")
          .eq("contactId", contact.id);

        const { data: eventContacts } = await supabase
          .from("EventContact")
          .select("event:eventId(id, title, date, eventType, notes, location, userId, ActionItem(*)), contactId")
          .eq("contactId", contact.id)
          .order("event(date)", { ascending: false })
          .limit(20);

        const events: any[] = [];
        const seenEventIds = new Set<string>();

        for (const ec of (eventContacts || []) as any[]) {
          const event = ec.event as any;
          if (!event || event.userId !== userId) continue;
          if (seenEventIds.has(event.id)) continue;
          seenEventIds.add(event.id);

          const { data: otherECs } = await supabase
            .from("EventContact")
            .select("contact:contactId(name)")
            .eq("eventId", event.id)
            .neq("contactId", contact.id);

          events.push({
            id: event.id,
            title: event.title,
            date: formatDateForOutput(event.date),
            eventType: event.eventType,
            location: event.location,
            notes: event.notes,
            otherContacts: (otherECs || []).map((oc: any) => oc.contact?.name).filter(Boolean),
            actionItems: (event.ActionItem || []).map((ai: any) => ({
              id: ai.id,
              description: ai.description,
              completed: ai.completed,
            })),
          });
        }

        const { count: totalEvents } = await supabase
          .from("EventContact")
          .select("eventId", { count: "exact", head: true })
          .eq("contactId", contact.id);

        const firstEventDate = events.length > 0 ? events[events.length - 1].date : null;

        const latestEvents = await fetchLatestEventsForContacts(supabase, userId, [contact.id]);
        const nextEvents = await fetchNextEventsForContacts(supabase, userId, [contact.id]);
        const [enriched] = computeContactStatuses(
          [{ ...contact, ContactOOOPeriod: oooPeriods || [] }],
          latestEvents,
          nextEvents
        );

        const now = new Date();
        const oooList = (oooPeriods || []) as any[];
        const currentOOO = oooList.find(
          (p: any) => new Date(p.startDate) <= now && new Date(p.endDate) >= now
        );
        const upcomingOOO = oooList.filter(
          (p: any) => new Date(p.startDate) > now
        );

        const result = {
          contact: {
            id: contact.id,
            name: contact.name,
            nickname: contact.nickname,
            notes: (contact as any).notes,
            metroArea: (contact as any).metroArea,
            location: (contact as any).location,
            funnelStage: (contact as any).funnelStage,
            relationship: (contact as any).relationship,
          },
          tags: (tagRows || []).map((t: any) => t.Tag?.name).filter(Boolean),
          cadenceStatus: {
            cadenceDays: (contact as any).cadenceDays,
            daysSinceLastEvent: enriched.status.daysSinceLastEvent,
            daysUntilDue: enriched.status.daysUntilDue,
            isOverdue: enriched.status.isOverdue,
          },
          ooo: {
            current: currentOOO
              ? {
                  label: currentOOO.label,
                  destination: currentOOO.destination,
                  startDate: formatDateForOutput(currentOOO.startDate),
                  endDate: formatDateForOutput(currentOOO.endDate),
                }
              : null,
            upcoming: upcomingOOO.map((p: any) => ({
              startDate: formatDateForOutput(p.startDate),
              endDate: formatDateForOutput(p.endDate),
              label: p.label,
              destination: p.destination,
            })),
          },
          relationships,
          importantDates: (importantDates || []).map((d: any) => ({
            type: d.dateType,
            label: d.label,
            month: d.month,
            day: d.day,
            year: d.year,
          })),
          events,
          totalEvents: totalEvents || events.length,
          firstEventDate,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // ─── get_upcoming ───────────────────────────────────────────
    server.tool(
      "get_upcoming",
      "Get planned future events and relevant OOO periods. Use when the user asks 'who am I seeing this week?', 'what's on my social calendar?', or anything about upcoming plans.",
      {
        days_ahead: z.number().optional().describe("Days to look ahead (default 14, max 90)"),
      },
      async (params) => {
        const daysAhead = Math.min(params.days_ahead || 14, 90);
        const now = new Date();
        const endDate = new Date(now);
        endDate.setDate(endDate.getDate() + daysAhead);

        const { data: eventRows } = await supabase
          .from("Event")
          .select("id, title, date, eventType, location, EventContact(contact:contactId(name, metroArea))")
          .eq("userId", userId)
          .gte("date", now.toISOString())
          .lte("date", endDate.toISOString())
          .order("date", { ascending: true });

        const events = (eventRows || []).map((e: any) => ({
          id: e.id,
          title: e.title,
          date: formatDateForOutput(e.date),
          eventType: e.eventType,
          location: e.location,
          contacts: (e.EventContact || []).map((ec: any) => ({
            name: ec.contact?.name,
            metroArea: ec.contact?.metroArea,
          })),
        }));

        const selfContact = await fetchSelfContact(supabase, userId);
        const selfOOO = (selfContact?.ContactOOOPeriod || [])
          .filter(
            (p: any) => new Date(p.startDate) <= endDate && new Date(p.endDate) >= now
          )
          .map((p: any) => ({
            startDate: formatDateForOutput(p.startDate),
            endDate: formatDateForOutput(p.endDate),
            label: p.label,
            destination: p.destination,
          }));

        const { data: oooContacts } = await supabase
          .from("ContactOOOPeriod")
          .select("startDate, endDate, label, destination, contact:contactId(name, userId, isSelf)")
          .lte("startDate", endDate.toISOString())
          .gte("endDate", now.toISOString());

        const contactOOO = (oooContacts || [])
          .filter((p: any) => p.contact?.userId === userId && !p.contact?.isSelf)
          .map((p: any) => ({
            contactName: p.contact?.name,
            startDate: formatDateForOutput(p.startDate),
            endDate: formatDateForOutput(p.endDate),
            label: p.label,
            destination: p.destination,
          }));

        const result = { events, ooo: { self: selfOOO, contacts: contactOOO } };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // ─── get_social_summary ─────────────────────────────────────
    server.tool(
      "get_social_summary",
      "Get a high-level summary of relationship health. Returns overdue contacts, upcoming events, who's currently away, open action items, upcoming birthdays, and funnel stage distribution. Use for morning briefings or general check-ins.",
      {},
      async () => {
        const now = new Date();

        const contacts = await fetchContactsWithMeta(supabase, userId);
        const contactIds = contacts.map((c: any) => c.id);

        const [latestEvents, nextEvents] = await Promise.all([
          fetchLatestEventsForContacts(supabase, userId, contactIds),
          fetchNextEventsForContacts(supabase, userId, contactIds),
        ]);

        const enriched = computeContactStatuses(contacts, latestEvents, nextEvents);

        const overdue = enriched
          .filter((c) => c.status.isOverdue && !c.status.isAway)
          .sort((a, b) => (a.status.daysUntilDue || 0) - (b.status.daysUntilDue || 0))
          .slice(0, 10)
          .map((c) => ({
            name: c.name,
            daysSinceLastEvent: c.status.daysSinceLastEvent,
            cadenceDays: c.cadenceDays,
            metroArea: c.metroArea,
          }));

        const dueSoon = enriched
          .filter((c) => (c.status.isDue || c.status.isDueSoon) && !c.status.isAway)
          .sort((a, b) => (a.status.daysUntilDue || 0) - (b.status.daysUntilDue || 0))
          .slice(0, 10)
          .map((c) => ({
            name: c.name,
            daysUntilDue: c.status.daysUntilDue,
            cadenceDays: c.cadenceDays,
            metroArea: c.metroArea,
          }));

        const currentlyAway = enriched
          .filter((c) => c.status.isAway)
          .map((c) => ({
            name: c.name,
            destination: c.status.currentOOOPeriod?.destination,
            returnDate: formatDateForOutput(c.status.currentOOOPeriod?.endDate),
            label: c.status.currentOOOPeriod?.label,
          }));

        const sevenDaysOut = new Date(now);
        sevenDaysOut.setDate(sevenDaysOut.getDate() + 7);

        const returningThisWeek = currentlyAway.filter((c) => {
          if (!c.returnDate) return false;
          return new Date(c.returnDate) <= sevenDaysOut;
        });

        const selfContact = await fetchSelfContact(supabase, userId);
        const selfPeriods = selfContact?.ContactOOOPeriod || [];
        const selfCurrent = selfPeriods.find(
          (p: any) => new Date(p.startDate) <= now && new Date(p.endDate) >= now
        );
        const selfNext = selfPeriods
          .filter((p: any) => new Date(p.startDate) > now)
          .sort((a: any, b: any) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime())[0];

        const weekEnd = new Date(now);
        weekEnd.setDate(weekEnd.getDate() + 7);

        const { data: upcomingEventRows } = await supabase
          .from("Event")
          .select("title, date, location, EventContact(contact:contactId(name))")
          .eq("userId", userId)
          .gte("date", now.toISOString())
          .lte("date", weekEnd.toISOString())
          .order("date", { ascending: true });

        const upcomingEvents = (upcomingEventRows || []).map((e: any) => ({
          title: e.title,
          date: formatDateForOutput(e.date),
          location: e.location,
          contacts: (e.EventContact || []).map((ec: any) => ec.contact?.name).filter(Boolean),
        }));

        const { data: allBirthdays } = await supabase
          .from("ImportantDate")
          .select("day, month, year, contact:contactId(name, userId)")
          .eq("dateType", "BIRTHDAY");

        const MONTH_NAMES = [
          "January", "February", "March", "April", "May", "June",
          "July", "August", "September", "October", "November", "December",
        ];

        const upcomingBirthdays = (allBirthdays || [])
          .filter((b: any) => b.contact?.userId === userId)
          .map((b: any) => {
            const thisYear = new Date(now.getFullYear(), b.month - 1, b.day);
            const nextYear = new Date(now.getFullYear() + 1, b.month - 1, b.day);
            const nextOccurrence = thisYear >= now ? thisYear : nextYear;
            const daysAway = daysBetween(now, nextOccurrence);
            return {
              name: b.contact?.name,
              date: `${MONTH_NAMES[b.month - 1]} ${b.day}`,
              daysAway,
            };
          })
          .filter((b: any) => b.daysAway <= 30 && b.daysAway >= 0)
          .sort((a: any, b: any) => a.daysAway - b.daysAway);

        const { data: actionItems } = await supabase
          .from("ActionItem")
          .select("id, description, event:eventId(title, EventContact(contact:contactId(name, userId)))")
          .eq("completed", false);

        const openActionItems = (actionItems || [])
          .filter((ai: any) => {
            const contacts = ai.event?.EventContact || [];
            return contacts.some((ec: any) => ec.contact?.userId === userId);
          })
          .map((ai: any) => ({
            id: ai.id,
            description: ai.description,
            fromEvent: ai.event?.title,
            contact: (ai.event?.EventContact || [])
              .map((ec: any) => ec.contact?.name)
              .filter(Boolean)
              .join(", "),
          }));

        const stageDistribution: Record<string, number> = {};
        for (const c of contacts) {
          const stage = (c as any).funnelStage;
          stageDistribution[stage] = (stageDistribution[stage] || 0) + 1;
        }

        const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

        const { count: eventsThisMonth } = await supabase
          .from("Event")
          .select("id", { count: "exact", head: true })
          .eq("userId", userId)
          .gte("date", thisMonthStart.toISOString());

        const { count: eventsLastMonth } = await supabase
          .from("Event")
          .select("id", { count: "exact", head: true })
          .eq("userId", userId)
          .gte("date", lastMonthStart.toISOString())
          .lt("date", thisMonthStart.toISOString());

        const result = {
          overdue,
          dueSoon,
          currentlyAway,
          returningThisWeek,
          selfOOO: {
            current: selfCurrent
              ? {
                  label: selfCurrent.label,
                  destination: selfCurrent.destination,
                  endDate: formatDateForOutput(selfCurrent.endDate),
                }
              : null,
            next: selfNext
              ? {
                  startDate: formatDateForOutput(selfNext.startDate),
                  endDate: formatDateForOutput(selfNext.endDate),
                  label: selfNext.label,
                }
              : null,
          },
          upcomingEvents,
          upcomingBirthdays,
          openActionItems,
          stageDistribution,
          stats: {
            totalContacts: contacts.length,
            eventsThisMonth: eventsThisMonth || 0,
            eventsLastMonth: eventsLastMonth || 0,
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // ─── log_event ──────────────────────────────────────────────
    server.tool(
      "log_event",
      "Log a social interaction — a hangout, call, text, or other contact with one or more people. Use when the user says things like 'I just had coffee with Alex' or 'log that I saw Marcus at the bar on Friday.'",
      {
        contact_names: z.array(z.string()).describe("Names of people involved"),
        date: z.string().optional().describe("ISO date (defaults to today)"),
        event_type: z.string().optional().describe("HANGOUT, CALL, MESSAGE, EVENT, OTHER"),
        title: z.string().optional().describe("Short description"),
        notes: z.string().optional().describe("What you discussed"),
        location: z.string().optional().describe("Where it happened"),
        action_items: z.array(z.string()).optional().describe("Follow-up items"),
      },
      async (params) => {
        const { matched, warnings } = await resolveContactNames(
          supabase, userId, params.contact_names
        );

        if (matched.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: "No contacts matched", warnings }),
            }],
          };
        }

        const eventDate = params.date
          ? parseLocalDateToUTC(params.date)
          : todayAtNoonUTC();

        const eventId = createId();

        const { error: eventError } = await supabase.from("Event").insert({
          id: eventId,
          userId,
          title: params.title || null,
          date: eventDate.toISOString(),
          eventType: params.event_type || "HANGOUT",
          notes: params.notes || null,
          location: params.location || null,
        });

        if (eventError) throw new Error(eventError.message);

        const eventContacts = matched.map((m) => ({
          eventId,
          contactId: m.id,
        }));

        const { error: ecError } = await supabase
          .from("EventContact")
          .insert(eventContacts);

        if (ecError) throw new Error(ecError.message);

        let actionItemsCreated = 0;
        if (params.action_items && params.action_items.length > 0) {
          const items = params.action_items.map((desc) => ({
            id: createId(),
            eventId,
            description: desc,
            completed: false,
          }));

          const { error: aiError } = await supabase
            .from("ActionItem")
            .insert(items);

          if (aiError) throw new Error(aiError.message);
          actionItemsCreated = items.length;
        }

        const matchedIds = matched.map((m) => m.id);

        const { data: fullContacts } = await supabase
          .from("Contact")
          .select("*, ContactOOOPeriod(*)")
          .in("id", matchedIds);

        const latestEvents = await fetchLatestEventsForContacts(supabase, userId, matchedIds);
        const nextEventsData = await fetchNextEventsForContacts(supabase, userId, matchedIds);
        const enrichedContacts = computeContactStatuses(
          fullContacts || [],
          latestEvents,
          nextEventsData
        );

        const contactsUpdated = enrichedContacts.map((c) => ({
          name: c.name,
          newDaysUntilDue: c.status.daysUntilDue,
        }));

        const result = {
          event: {
            id: eventId,
            title: params.title || null,
            date: formatDateForOutput(eventDate),
            location: params.location || null,
            contacts: matched.map((m) => m.name),
          },
          contactsUpdated,
          actionItemsCreated,
          warnings,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // ─── add_contact ────────────────────────────────────────────
    server.tool(
      "add_contact",
      "Add a new person to Tend. Use when the user mentions someone new they want to track, like 'add my new coworker Priya.'",
      {
        name: z.string().describe("Full name"),
        nickname: z.string().optional().describe("Familiar name"),
        notes: z.string().optional().describe("Notes about them"),
        relationship: z.string().optional().describe("How you know them"),
        cadence_days: z.number().optional().describe("Days between contact"),
        stage: z.string().optional().describe("Funnel stage (default ACQUAINTANCE)"),
        metro_area: z.string().optional().describe("Where they live"),
        tags: z.array(z.string()).optional().describe("Tag names (created if new)"),
      },
      async (params) => {
        const contactId = createId();
        const metroArea = normalizeMetroArea(params.metro_area);

        const { error: contactError } = await supabase.from("Contact").insert({
          id: contactId,
          userId,
          name: params.name,
          nickname: params.nickname || null,
          notes: params.notes || null,
          relationship: params.relationship || null,
          cadenceDays: params.cadence_days || null,
          funnelStage: params.stage || "ACQUAINTANCE",
          metroArea,
        });

        if (contactError) throw new Error(contactError.message);

        const tagNames = params.tags || [];
        const appliedTags: string[] = [];

        for (const tagName of tagNames) {
          let { data: existingTag } = await supabase
            .from("Tag")
            .select("id, name")
            .eq("userId", userId)
            .eq("name", tagName)
            .single();

          if (!existingTag) {
            const tagId = createId();
            const { data: newTag, error: tagError } = await supabase
              .from("Tag")
              .insert({ id: tagId, userId, name: tagName })
              .select()
              .single();

            if (tagError) throw new Error(tagError.message);
            existingTag = newTag;
          }

          await supabase
            .from("ContactTag")
            .insert({ contactId, tagId: existingTag!.id });

          appliedTags.push(existingTag!.name);
        }

        const result = {
          id: contactId,
          name: params.name,
          nickname: params.nickname || null,
          funnelStage: params.stage || "ACQUAINTANCE",
          cadenceDays: params.cadence_days || null,
          metroArea,
          tags: appliedTags,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // ─── update_contact ─────────────────────────────────────────
    server.tool(
      "update_contact",
      "Update a contact's info — cadence, funnel stage, notes, location, or tags. Use when the user wants to change how often they see someone, move someone to a different stage, or update notes.",
      {
        contact_id: z.string().optional().describe("Contact ID"),
        name: z.string().optional().describe("Contact name (fuzzy matched)"),
        updates: z
          .object({
            cadenceDays: z.number().nullable().optional(),
            funnelStage: z.string().optional(),
            notes: z.string().nullable().optional(),
            nickname: z.string().nullable().optional(),
            relationship: z.string().nullable().optional(),
            metroArea: z.string().nullable().optional(),
            location: z.string().nullable().optional(),
          })
          .describe("Fields to update"),
        add_tags: z.array(z.string()).optional().describe("Tags to add"),
        remove_tags: z.array(z.string()).optional().describe("Tags to remove"),
      },
      async (params) => {
        const { contact, warning } = await resolveContactByNameOrId(
          supabase, userId, { contactId: params.contact_id, name: params.name }
        );

        if (!contact) {
          return { content: [{ type: "text" as const, text: warning! }] };
        }

        const updateData: Record<string, unknown> = {};
        const updates = params.updates || {};

        if (updates.cadenceDays !== undefined) updateData.cadenceDays = updates.cadenceDays;
        if (updates.funnelStage !== undefined) updateData.funnelStage = updates.funnelStage;
        if (updates.notes !== undefined) updateData.notes = updates.notes;
        if (updates.nickname !== undefined) updateData.nickname = updates.nickname;
        if (updates.relationship !== undefined) updateData.relationship = updates.relationship;
        if (updates.location !== undefined) updateData.location = updates.location;
        if (updates.metroArea !== undefined) {
          updateData.metroArea = normalizeMetroArea(updates.metroArea);
        }

        if (Object.keys(updateData).length > 0) {
          const { error } = await supabase
            .from("Contact")
            .update(updateData)
            .eq("id", contact.id);
          if (error) throw new Error(error.message);
        }

        for (const tagName of params.add_tags || []) {
          let { data: existingTag } = await supabase
            .from("Tag")
            .select("id")
            .eq("userId", userId)
            .eq("name", tagName)
            .single();

          if (!existingTag) {
            const { data: newTag } = await supabase
              .from("Tag")
              .insert({ id: createId(), userId, name: tagName })
              .select()
              .single();
            existingTag = newTag;
          }

          if (existingTag) {
            await supabase
              .from("ContactTag")
              .upsert({ contactId: contact.id, tagId: existingTag.id });
          }
        }

        for (const tagName of params.remove_tags || []) {
          const { data: tag } = await supabase
            .from("Tag")
            .select("id")
            .eq("userId", userId)
            .eq("name", tagName)
            .single();

          if (tag) {
            await supabase
              .from("ContactTag")
              .delete()
              .eq("contactId", contact.id)
              .eq("tagId", tag.id);
          }
        }

        const { data: updated } = await supabase
          .from("Contact")
          .select("*, ContactTag(Tag:tagId(name, color)), ContactOOOPeriod(*)")
          .eq("id", contact.id)
          .single();

        const latestEvents = await fetchLatestEventsForContacts(supabase, userId, [contact.id]);
        const nextEventsData = await fetchNextEventsForContacts(supabase, userId, [contact.id]);
        const [enrichedContact] = computeContactStatuses(
          [updated],
          latestEvents,
          nextEventsData
        );

        const result = {
          id: updated.id,
          name: updated.name,
          nickname: updated.nickname,
          funnelStage: updated.funnelStage,
          cadenceDays: updated.cadenceDays,
          metroArea: updated.metroArea,
          tags: formatContactTags(updated),
          cadenceStatus: {
            daysUntilDue: enrichedContact.status.daysUntilDue,
            isOverdue: enrichedContact.status.isOverdue,
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // ─── complete_action_item ───────────────────────────────────
    server.tool(
      "complete_action_item",
      "Mark an action item as completed. Use when the user says they've done a follow-up, like 'I sent Alex that article.'",
      {
        action_item_id: z.string().optional().describe("Action item ID"),
        description_search: z.string().optional().describe("Fuzzy match on description"),
      },
      async (params) => {
        let actionItem: any = null;

        if (params.action_item_id) {
          const { data } = await supabase
            .from("ActionItem")
            .select("*, event:eventId(title, userId, EventContact(contact:contactId(name)))")
            .eq("id", params.action_item_id)
            .single();

          if (data && (data.event as any)?.userId === userId) {
            actionItem = data;
          }
        } else if (params.description_search) {
          const { data: items } = await supabase
            .from("ActionItem")
            .select("*, event:eventId(title, userId, EventContact(contact:contactId(name)))")
            .eq("completed", false)
            .ilike("description", `%${params.description_search}%`);

          const userItems = (items || []).filter(
            (ai: any) => (ai.event as any)?.userId === userId
          );

          if (userItems.length === 1) {
            actionItem = userItems[0];
          } else if (userItems.length > 1) {
            const candidates = userItems.map((ai: any) => ({
              id: ai.id,
              description: ai.description,
              fromEvent: (ai.event as any)?.title,
            }));
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: "Multiple matches found. Please specify by ID.",
                  candidates,
                }),
              }],
            };
          } else {
            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  error: `No open action items matching "${params.description_search}"`,
                }),
              }],
            };
          }
        }

        if (!actionItem) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ error: "Action item not found" }),
            }],
          };
        }

        const { error } = await supabase
          .from("ActionItem")
          .update({ completed: true })
          .eq("id", actionItem.id);

        if (error) throw new Error(error.message);

        const result = {
          id: actionItem.id,
          description: actionItem.description,
          completed: true,
          fromEvent: actionItem.event?.title,
          contacts: (actionItem.event?.EventContact || [])
            .map((ec: any) => ec.contact?.name)
            .filter(Boolean),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // ─── update_event ───────────────────────────────────────────
    server.tool(
      "update_event",
      "Update an existing event's details — title, notes, location, date, event type, or contacts. Use when the user wants to fix or enrich an event. You need the event ID (returned by get_contact_detail, get_upcoming, or log_event).",
      {
        event_id: z.string().describe("Event ID to update"),
        title: z.string().nullable().optional().describe("New title"),
        notes: z.string().nullable().optional().describe("New notes"),
        location: z.string().nullable().optional().describe("New location"),
        date: z.string().optional().describe("New date (ISO format)"),
        event_type: z.string().optional().describe("HANGOUT, CALL, MESSAGE, EVENT, OTHER"),
        contact_names: z.array(z.string()).optional().describe("Replace contacts (fuzzy matched). Omit to keep existing."),
      },
      async (params) => {
        const { data: existing } = await supabase
          .from("Event")
          .select("id, title, date, eventType, notes, location, userId")
          .eq("id", params.event_id)
          .single();

        if (!existing || (existing as any).userId !== userId) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Event not found" }) }],
          };
        }

        const updateData: Record<string, unknown> = {};
        if (params.title !== undefined) updateData.title = params.title;
        if (params.notes !== undefined) updateData.notes = params.notes;
        if (params.location !== undefined) updateData.location = params.location;
        if (params.event_type !== undefined) updateData.eventType = params.event_type;
        if (params.date !== undefined) {
          updateData.date = parseLocalDateToUTC(params.date).toISOString();
        }

        if (Object.keys(updateData).length > 0) {
          const { error } = await supabase
            .from("Event")
            .update(updateData)
            .eq("id", params.event_id);
          if (error) throw new Error(error.message);
        }

        const warnings: string[] = [];
        if (params.contact_names) {
          const { matched, warnings: matchWarnings } = await resolveContactNames(
            supabase, userId, params.contact_names
          );
          warnings.push(...matchWarnings);

          if (matched.length > 0) {
            await supabase
              .from("EventContact")
              .delete()
              .eq("eventId", params.event_id);

            await supabase
              .from("EventContact")
              .insert(matched.map((m) => ({ eventId: params.event_id, contactId: m.id })));
          }
        }

        const { data: updated } = await supabase
          .from("Event")
          .select("id, title, date, eventType, notes, location, EventContact(contact:contactId(name))")
          .eq("id", params.event_id)
          .single();

        const result = {
          event: {
            id: (updated as any).id,
            title: (updated as any).title,
            date: formatDateForOutput((updated as any).date),
            eventType: (updated as any).eventType,
            notes: (updated as any).notes,
            location: (updated as any).location,
            contacts: ((updated as any).EventContact || []).map((ec: any) => ec.contact?.name).filter(Boolean),
          },
          warnings,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    );

    // ─── delete_event ───────────────────────────────────────────
    server.tool(
      "delete_event",
      "Delete an event. Use when the user says 'delete that event' or 'that was a mistake, remove it.' Requires the event ID. Also removes associated action items.",
      {
        event_id: z.string().describe("Event ID to delete"),
      },
      async (params) => {
        const { data: existing } = await supabase
          .from("Event")
          .select("id, title, userId, EventContact(contact:contactId(name))")
          .eq("id", params.event_id)
          .single();

        if (!existing || (existing as any).userId !== userId) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Event not found" }) }],
          };
        }

        const { error } = await supabase
          .from("Event")
          .delete()
          .eq("id", params.event_id);

        if (error) throw new Error(error.message);

        const result = {
          deleted: true,
          event: {
            id: (existing as any).id,
            title: (existing as any).title,
            contacts: ((existing as any).EventContact || []).map((ec: any) => ec.contact?.name).filter(Boolean),
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      }
    );
  },
  {},
  { basePath: "/api" }
);

// Verify bearer tokens — accepts both direct bearer tokens and OAuth-issued tokens
const verifyToken = async (
  _req: Request,
  bearerToken?: string
): Promise<AuthInfo | undefined> => {
  if (!bearerToken) return undefined;

  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected || bearerToken !== expected) return undefined;

  return {
    token: bearerToken,
    scopes: ["mcp:tools"],
    clientId: "tend-user",
  };
};

const authHandler = withMcpAuth(handler, verifyToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource",
});

export { authHandler as GET, authHandler as POST, authHandler as DELETE };
