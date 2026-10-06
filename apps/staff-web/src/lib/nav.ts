import type { ComponentType, SVGProps } from 'react';
import {
  ArrivalIcon,
  BedIcon,
  BookIcon,
  BoxIcon,
  ChatIcon,
  ClipboardIcon,
  DeskIcon,
  DiningIcon,
  GaugeIcon,
  GridIcon,
  HeartIcon,
  KeyIcon,
  PaletteIcon,
  PhoneIcon,
  ShieldIcon,
  SparkleIcon,
  UsersIcon,
  WrenchIcon,
} from '@hotella/ui';
import { holdsAnywhere } from './access';
import type { Me } from './types';

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

/** A screen: its path, the permission that opens it (held at any property) and the licensed module it belongs to. */
export interface NavItem {
  /** Locale key suffix (`staff.app.section_<key>`). */
  readonly key: string;
  readonly href: string;
  readonly permission: string;
  readonly capability: string;
  readonly icon: Icon;
}

/**
 * The screens grouped the way a hotel is organised: the desk, the operating departments, guest care and management.
 * Each person sees only the items their role opens and the hotel's licence includes (rule 14); a group with nothing
 * left is not shown.
 */
export const NAV_GROUPS: ReadonlyArray<{
  readonly key: string;
  readonly items: readonly NavItem[];
}> = [
  {
    key: 'desk',
    items: [
      {
        key: 'front_desk',
        href: '/front-desk',
        permission: 'stay.read',
        capability: 'CORE',
        icon: DeskIcon,
      },
      {
        key: 'inbox',
        href: '/inbox',
        permission: 'inbox.read',
        capability: 'GUEST_EXPERIENCE',
        icon: ChatIcon,
      },
      {
        key: 'arrivals',
        href: '/arrivals',
        permission: 'hk.arrivals.read',
        capability: 'HOUSEKEEPING',
        icon: ArrivalIcon,
      },
      { key: 'keys', href: '/keys', permission: 'access.read', capability: 'CORE', icon: KeyIcon },
    ],
  },
  {
    key: 'operations',
    items: [
      {
        key: 'housekeeping',
        href: '/housekeeping',
        permission: 'hk.board.read',
        capability: 'HOUSEKEEPING',
        icon: BedIcon,
      },
      {
        key: 'engineering',
        href: '/engineering',
        permission: 'eng.work_order.read',
        capability: 'ENGINEERING',
        icon: WrenchIcon,
      },
      {
        key: 'telemetry',
        href: '/telemetry',
        permission: 'eng.telemetry.read',
        capability: 'ENGINEERING',
        icon: GaugeIcon,
      },
      {
        key: 'inspections',
        href: '/inspections',
        permission: 'inspection.read',
        capability: 'INSPECTIONS',
        icon: ClipboardIcon,
      },
    ],
  },
  {
    key: 'guests',
    items: [
      {
        key: 'relations',
        href: '/relations',
        permission: 'complaint.read',
        capability: 'GUEST_RELATIONS',
        icon: HeartIcon,
      },
      {
        key: 'restaurant',
        href: '/restaurant',
        permission: 'restaurant.restaurant.read',
        capability: 'RESTAURANT',
        icon: DiningIcon,
      },
      {
        key: 'lostfound',
        href: '/lostfound',
        permission: 'lostfound.register',
        capability: 'LOST_FOUND',
        icon: BoxIcon,
      },
    ],
  },
  {
    key: 'management',
    items: [
      {
        key: 'logbook',
        href: '/logbook',
        permission: 'logbook.read',
        capability: 'LOGBOOK',
        icon: BookIcon,
      },
      {
        key: 'intelligence',
        href: '/intelligence',
        permission: 'ai.insight.read',
        capability: 'AI_INTELLIGENCE',
        icon: SparkleIcon,
      },
      {
        key: 'services',
        href: '/services',
        permission: 'catalog.manage',
        capability: 'GUEST_EXPERIENCE',
        icon: GridIcon,
      },
      {
        key: 'staff',
        href: '/staff',
        permission: 'iam.user.read',
        capability: 'CORE',
        icon: UsersIcon,
      },
      {
        key: 'branding',
        href: '/branding',
        permission: 'branding.manage',
        capability: 'CORE',
        icon: PaletteIcon,
      },
    ],
  },
];

/** Planova's control plane (Spec §63): only platform administrators; hotel staff never see it. */
export const CONTROL_ITEM: NavItem = {
  key: 'control',
  href: '/control',
  permission: '',
  capability: 'CORE',
  icon: ShieldIcon,
};

/** The groups and items this person may open. */
export function visibleNav(me: Me, entitled: (capability: string) => boolean) {
  const groups = NAV_GROUPS.map((g) => ({
    key: g.key,
    items: g.items.filter((i) => holdsAnywhere(me, i.permission) && entitled(i.capability)),
  })).filter((g) => g.items.length > 0);
  return me.user.isPlatformAdmin ? [...groups, { key: 'platform', items: [CONTROL_ITEM] }] : groups;
}

/** Something staff start often ("+ New" and the home page): where it opens and what it needs. */
export interface QuickAction {
  /** Locale key suffix (`staff.app.new_<key>`). */
  readonly key: string;
  readonly href: string;
  /** Every one of these must be held somewhere. */
  readonly permissions: readonly string[];
  readonly capability: string;
  readonly icon: Icon;
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    key: 'request',
    href: '/front-desk?do=request',
    permissions: ['stay.read', 'request.create'],
    capability: 'GUEST_EXPERIENCE',
    icon: PhoneIcon,
  },
  {
    key: 'booking',
    href: '/front-desk?do=restaurant',
    permissions: ['stay.read', 'restaurant.reservation.manage'],
    capability: 'RESTAURANT',
    icon: DiningIcon,
  },
  {
    // A restaurant host without the front desk books from the restaurant's own screen.
    key: 'booking_host',
    href: '/restaurant',
    permissions: ['restaurant.reservation.manage'],
    capability: 'RESTAURANT',
    icon: DiningIcon,
  },
  {
    key: 'complaint',
    href: '/relations',
    permissions: ['complaint.manage'],
    capability: 'GUEST_RELATIONS',
    icon: HeartIcon,
  },
  {
    key: 'fault',
    href: '/engineering',
    permissions: ['eng.work_order.manage'],
    capability: 'ENGINEERING',
    icon: WrenchIcon,
  },
  {
    key: 'lost_item',
    href: '/lostfound',
    permissions: ['lostfound.register'],
    capability: 'LOST_FOUND',
    icon: BoxIcon,
  },
  {
    key: 'log_entry',
    href: '/logbook',
    permissions: ['logbook.write'],
    capability: 'LOGBOOK',
    icon: BookIcon,
  },
  {
    key: 'invite',
    href: '/staff',
    permissions: ['iam.user.manage'],
    capability: 'CORE',
    icon: UsersIcon,
  },
];

export function visibleActions(me: Me, entitled: (capability: string) => boolean) {
  const held = (a: QuickAction) =>
    a.permissions.every((p) => holdsAnywhere(me, p)) && entitled(a.capability);
  const actions = QUICK_ACTIONS.filter(held);
  // One booking entry: the desk's (with the room) when the person has it.
  return actions.some((a) => a.key === 'booking')
    ? actions.filter((a) => a.key !== 'booking_host')
    : actions;
}
