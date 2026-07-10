import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView } from 'react-native';
import { Q } from '@nozbe/watermelondb';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { MaterialIcons } from '@expo/vector-icons';
import database from '@/lib/database';
import dbSchema from '@/lib/database/schema';
import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import {
    Table,
    TableBody,
    TableData,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { tableLabel } from './observability-labels';
import { useThemeColors } from '@/lib/theme/tokens';

const PAGE_SIZE = 20;

function formatCellValue(value: unknown): string {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (value > 1_000_000_000_000) {
            const d = new Date(value);
            return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
        }
        return String(value);
    }
    const str = String(value);
    return str.length > 40 ? `${str.slice(0, 40)}…` : str;
}

interface TableDetailScreenProps {
    tableName: string;
    onBack: () => void;
}

const TableDetailScreen: React.FC<TableDetailScreenProps> = ({ tableName, onBack }) => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();
    const colors = useThemeColors();

    const tableInfo = dbSchema.tables[tableName];
    const columns = ['id', ...(tableInfo ? tableInfo.columnArray.map((c) => c.name) : [])];

    const [rows, setRows] = useState<Record<string, unknown>[]>([]);
    const [totalCount, setTotalCount] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    // Tracks how many rows have been fetched so far for offset calculation
    const offsetRef = useRef(0);

    const fetchPage = useCallback(async (offset: number, append: boolean) => {
        const fetched = await database
            .get(tableName)
            .query(Q.take(PAGE_SIZE), Q.skip(offset))
            .fetch();
        const raw = fetched.map(
            (r) => (r as unknown as { _raw: Record<string, unknown> })._raw,
        );
        setRows((prev) => (append ? [...prev, ...raw] : raw));
        offsetRef.current = offset + raw.length;
        return raw.length;
    }, [tableName]);

    const initialLoad = useCallback(async () => {
        setLoading(true);
        try {
            const count = await database.get(tableName).query().fetchCount();
            setTotalCount(count);
            offsetRef.current = 0;
            await fetchPage(0, false);
        } finally {
            setLoading(false);
        }
    }, [tableName, fetchPage]);

    const loadMore = useCallback(async () => {
        if (loadingMore) return;
        setLoadingMore(true);
        try {
            await fetchPage(offsetRef.current, true);
        } finally {
            setLoadingMore(false);
        }
    }, [loadingMore, fetchPage]);

    useEffect(() => { void initialLoad(); }, [initialLoad]);

    const hasMore = totalCount !== null && offsetRef.current < totalCount;

    const subtitle = loading
        ? t('common.loading')
        : totalCount !== null
            ? t('tableDetail.rowsOfCols', { rows: rows.length, total: totalCount, cols: columns.length })
            : t('tableDetail.rowsAndCols', { rows: rows.length, cols: columns.length });

    return (
        <Box className="flex-1 bg-background-0" style={{ paddingTop: insets.top }}>
            <HStack className="px-4 py-3 items-center justify-between">
                <Pressable onPress={onBack} className="bg-background-50 rounded-full p-2" hitSlop={8}>
                    <MaterialIcons name="arrow-back" size={20} color={colors.icon} />
                </Pressable>
                <VStack className="items-center flex-1 mx-4">
                    <Text className="text-typography-950 font-semibold text-base" numberOfLines={1}>
                        {tableLabel(tableName)}
                    </Text>
                    <Text size="xs" className="text-typography-400">{subtitle}</Text>
                </VStack>
                <Pressable
                    onPress={() => void initialLoad()}
                    className="bg-background-50 rounded-full p-2"
                    hitSlop={8}
                    disabled={loading}
                >
                    <MaterialIcons name="refresh" size={20} color={loading ? colors.iconMuted : colors.icon} />
                </Pressable>
            </HStack>

            {!loading && rows.length === 0 ? (
                <Box className="flex-1 items-center justify-center">
                    <Text className="text-typography-400">{t('tableDetail.tableEmpty')}</Text>
                </Box>
            ) : (
                <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
                    <ScrollView horizontal showsHorizontalScrollIndicator>
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    {columns.map((col) => (
                                        <TableHead
                                            key={col}
                                            useRNView
                                            className="border border-outline-50 bg-background-50 px-3 py-2"
                                            style={{ minWidth: 110 }}
                                        >
                                            <Text
                                                size="xs"
                                                className="text-typography-500 font-semibold"
                                                numberOfLines={1}
                                            >
                                                {col}
                                            </Text>
                                        </TableHead>
                                    ))}
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {rows.map((row, i) => (
                                    <TableRow
                                        key={String(row.id ?? i)}
                                        className={i % 2 === 0 ? 'bg-background-0' : 'bg-background-50'}
                                    >
                                        {columns.map((col) => (
                                            <TableData
                                                key={col}
                                                useRNView
                                                className="border border-outline-50 px-3 py-2"
                                                style={{ minWidth: 110 }}
                                            >
                                                <Text size="xs" className="text-typography-950">
                                                    {formatCellValue(row[col])}
                                                </Text>
                                            </TableData>
                                        ))}
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </ScrollView>

                    {/* Load more / end indicator */}
                    <Box className="py-4 items-center">
                        {hasMore ? (
                            <Pressable
                                onPress={() => void loadMore()}
                                disabled={loadingMore}
                                className="bg-background-50 border border-outline-100 rounded-lg px-5 py-2.5"
                            >
                                <Text size="xs" className={loadingMore ? 'text-typography-400' : 'text-typography-700'}>
                                    {loadingMore ? t('common.loading') : t('tableDetail.loadMore', { count: PAGE_SIZE })}
                                </Text>
                            </Pressable>
                        ) : !loading && rows.length > 0 ? (
                            <Text size="xs" className="text-typography-300">{t('tableDetail.allRowsLoaded', { count: totalCount })}</Text>
                        ) : null}
                    </Box>
                </ScrollView>
            )}
        </Box>
    );
};

export default TableDetailScreen;
