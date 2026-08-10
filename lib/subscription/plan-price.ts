import { PACKAGE_TYPE } from 'react-native-purchases';
import type { PurchasesOffering, PurchasesPackage } from 'react-native-purchases';

/**
 * The price as displayed: the store's localized `priceString` plus a period
 * suffix, so "€1.99" reads as "€1.99/month" rather than as a one-off charge.
 *
 * GATED ON THE PACKAGE'S ACTUAL PERIOD, never hardcoded. Every plan is monthly
 * today, which is precisely why a hardcoded "/month" would survive review and
 * every screenshot, and then quietly start lying the day an annual plan ships.
 * An unrecognised period renders the bare price — no suffix is always better
 * than a wrong one.
 *
 * `priceString` is already locale- and currency-formatted by the store; only
 * the suffix is ours to translate, and it is passed in rather than looked up
 * so this module stays free of i18n and of React.
 *
 * It lives in `lib/` rather than beside its one caller for a concrete reason,
 * not tidiness: `ManageSubscriptionScreen` transitively imports
 * `AbstractGradientBackdrop` → reanimated, whose native module is not
 * initialised under jest, so a pure function exported from that file cannot be
 * unit-tested at all.
 */
export function formatPackagePrice(
    pkg: PurchasesPackage | null,
    perMonthSuffix: string,
): string | null {
    if (!pkg) return null;
    const price = pkg.product?.priceString;
    if (!price) return null;
    return pkg.packageType === PACKAGE_TYPE.MONTHLY
        ? `${price}${perMonthSuffix}`
        : price;
}

/**
 * Price lives on the offering's packages, not on CustomerInfo — match the
 * active entitlement's product back to the package that sells it.
 */
export function resolvePricePackage(
    productId: string | null,
    offering: PurchasesOffering | null,
): PurchasesPackage | null {
    if (!productId || !offering) return null;
    return (
        offering.availablePackages.find(
            (p) =>
                p.product.identifier === productId ||
                // Android product ids can carry a ":basePlan" suffix.
                p.product.identifier.startsWith(`${productId}:`) ||
                productId.startsWith(`${p.product.identifier}:`),
        ) ?? null
    );
}
