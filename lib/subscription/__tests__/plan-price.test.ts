// The price label is one pure function, and it is pinned here because the
// wrong version LOOKS RIGHT and produces no error.
//
// Every plan is monthly today. That is exactly why "€1.99/month" must not be
// built by concatenating a hardcoded suffix: it would pass review, pass every
// screenshot, and then quietly start lying the day an annual plan ships. The
// suffix is gated on the package's ACTUAL period, and the non-monthly case
// below is the only thing that can catch a regression to the hardcoded form.

import { PACKAGE_TYPE } from 'react-native-purchases';
import type { PurchasesPackage } from 'react-native-purchases';
import { formatPackagePrice } from '../plan-price';

const pkg = (packageType: string, priceString = '€1.99') =>
    ({ packageType, product: { priceString } } as unknown as PurchasesPackage);

describe('formatPackagePrice', () => {
    it('appends the per-month suffix to a MONTHLY package', () => {
        expect(formatPackagePrice(pkg(PACKAGE_TYPE.MONTHLY), '/month')).toBe(
            '€1.99/month',
        );
    });

    it('leaves a non-monthly package BARE rather than mislabelling it', () => {
        // The regression this file exists for: a hardcoded suffix would render
        // "€19.99/month" for a yearly plan.
        expect(formatPackagePrice(pkg(PACKAGE_TYPE.ANNUAL, '€19.99'), '/month')).toBe(
            '€19.99',
        );
        expect(formatPackagePrice(pkg(PACKAGE_TYPE.LIFETIME, '€99'), '/month')).toBe(
            '€99',
        );
        // An unrecognised period is the same case: no suffix beats a wrong one.
        expect(formatPackagePrice(pkg('UNKNOWN', '€5'), '/month')).toBe('€5');
    });

    it('renders nothing when there is no package or no store price', () => {
        expect(formatPackagePrice(null, '/month')).toBeNull();
        expect(formatPackagePrice(pkg(PACKAGE_TYPE.MONTHLY, ''), '/month')).toBeNull();
    });

    it('does not touch the store-formatted price itself', () => {
        // `priceString` arrives already localised and currency-formatted by the
        // store — only the suffix is ours to translate.
        expect(formatPackagePrice(pkg(PACKAGE_TYPE.MONTHLY, '¥300'), 'ま月')).toBe(
            '¥300ま月',
        );
    });
});
