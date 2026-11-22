/**
 * Writable work-item fields (Milestone 7): the administrator's allowlist and each session's
 * destination field mapping. Three things stay separate: display-only ticket fields, the
 * allowlist of writable fields, and a session's mapping of cards to one allowlisted field.
 */
import type {
  FieldAllowlistView,
  FieldMappingView,
  WritableFieldView,
} from '@planning-poker/contracts';
import type { FieldMapping, Session, TenantId } from '@planning-poker/domain';
import { DomainError, isRegularCard } from '@planning-poker/domain';

import type { ApplicationDependencies } from './dependencies';
import type { ExternalField } from './ports';

/** Upper bound for the allowlist; a site rarely needs more than a handful. */
export const MAX_WRITABLE_FIELDS = 20;

type FieldDeps = Pick<ApplicationDependencies, 'settings' | 'workItems'>;

/** Number and single-select fields, the only types estimates are written to for now. */
export function writableFields(fields: readonly ExternalField[]): WritableFieldView[] {
  return fields
    .flatMap((field): WritableFieldView[] =>
      field.valueType === 'unsupported'
        ? []
        : [{ id: field.fieldId, name: field.name, valueType: field.valueType }],
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function allowlistView(
  fields: readonly ExternalField[],
  selectedIds: readonly string[],
): FieldAllowlistView {
  return { available: writableFields(fields), selectedIds: [...selectedIds] };
}

/** Validates an allowlist change against the fields the provider reports. */
export function validateAllowlist(
  fields: readonly ExternalField[],
  fieldIds: readonly string[],
): string[] {
  const unique = [...new Set(fieldIds)];

  if (unique.length > MAX_WRITABLE_FIELDS) {
    throw new DomainError(
      'VALIDATION',
      `Allow at most ${String(MAX_WRITABLE_FIELDS)} writable fields.`,
    );
  }

  const supported = new Set(writableFields(fields).map((field) => field.id));

  if (!unique.every((id) => supported.has(id))) {
    throw new DomainError('VALIDATION', 'Choose number or single-select fields from the list.');
  }

  return unique;
}

async function allowedFields(deps: FieldDeps, tenantId: TenantId): Promise<WritableFieldView[]> {
  const [settings, fields] = await Promise.all([
    deps.settings.get(tenantId),
    deps.workItems.discoverFields(),
  ]);

  return writableFields(fields).filter((field) => settings.writableFieldIds.includes(field.id));
}

async function optionValues(deps: FieldDeps, session: Session, fieldId: string): Promise<string[]> {
  const options = await deps.workItems.listFieldOptions(
    fieldId,
    session.tickets.map((ticket) => ticket.reference),
  );

  return [...new Set(options.map((option) => option.value))];
}

export async function fieldMappingView(
  deps: FieldDeps,
  session: Session,
): Promise<FieldMappingView> {
  const destination = session.settings.destinationField;
  const options =
    destination?.valueType === 'option'
      ? await optionValues(deps, session, destination.fieldId)
      : [];

  return {
    allowed: await allowedFields(deps, session.tenantId),
    destination:
      destination === null
        ? null
        : {
            fieldId: destination.fieldId,
            fieldName: destination.fieldName,
            valueType: destination.valueType,
            optionByCardId: Object.fromEntries(
              Object.entries(destination.optionByCardId).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
          },
    options,
  };
}

export interface FieldMappingInput {
  readonly fieldId: string | null;
  readonly optionByCardId: Readonly<Record<string, string>>;
}

/**
 * Builds the session's destination mapping from the moderator's choice. The field must be on the
 * allowlist and be a number or single-select field; option values must be ones the field
 * accepts on the session's tickets. Completeness (every regular card mapped) is a readiness
 * check, so a mapping can be saved one card at a time.
 */
export async function resolveDestination(
  deps: FieldDeps,
  session: Session,
  input: FieldMappingInput,
): Promise<FieldMapping | null> {
  if (input.fieldId === null) {
    return null;
  }

  const field = (await allowedFields(deps, session.tenantId)).find(
    (entry) => entry.id === input.fieldId,
  );

  if (field === undefined) {
    throw new DomainError('VALIDATION', 'Choose a field your administrator allows.');
  }

  if (field.valueType === 'number') {
    return { fieldId: field.id, fieldName: field.name, valueType: 'number', optionByCardId: {} };
  }

  const entries = Object.entries(input.optionByCardId).filter(([, value]) => value !== '');
  const accepted = entries.length === 0 ? [] : await optionValues(deps, session, field.id);
  const regularCardIds = new Set<string>(
    session.settings.deck.cards.filter(isRegularCard).map((card) => card.id),
  );

  for (const [cardId, value] of entries) {
    if (!regularCardIds.has(cardId)) {
      throw new DomainError('VALIDATION', 'Map only the regular cards of this deck.');
    }

    if (!accepted.includes(value)) {
      throw new DomainError('VALIDATION', `"${value}" is not an option of ${field.name}.`);
    }
  }

  return {
    fieldId: field.id,
    fieldName: field.name,
    valueType: 'option',
    optionByCardId: Object.fromEntries(entries),
  };
}
