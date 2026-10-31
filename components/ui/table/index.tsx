import React, { createContext, useMemo, useContext } from 'react';
import {
  Table as ExpoTable,
  THead as ExpoTHead,
  TBody as ExpoTBody,
  TFoot as ExpoTFoot,
  TR as ExpoTR,
  Caption as ExpoTCaption,
} from '@expo/html-elements';

import {
  tableStyle,
  tableHeaderStyle,
  tableBodyStyle,
  tableFooterStyle,
  tableHeadStyle,
  tableRowStyleStyle,
  tableDataStyle,
  tableCaptionStyle,
} from './styles';
import { Text, View, type ViewInstance } from 'react-native';

const TableHeaderContext = createContext<{
  isHeaderRow: boolean;
}>({
  isHeaderRow: false,
});
const TableFooterContext = createContext<{
  isFooterRow: boolean;
}>({
  isFooterRow: false,
});

type ITableProps = React.ComponentProps<typeof ExpoTable>;
type ITableHeaderProps = React.ComponentProps<typeof ExpoTHead>;
type ITableBodyProps = React.ComponentProps<typeof ExpoTBody>;
type ITableFooterProps = React.ComponentProps<typeof ExpoTFoot>;
type ITableHeadProps = React.ComponentProps<typeof View | typeof Text> & {
  useRNView?: boolean;
};
type ITableRowProps = React.ComponentProps<typeof ExpoTR>;
type ITableDataProps = React.ComponentProps<typeof View | typeof Text> & {
  useRNView?: boolean;
};
type ITableCaptionProps = React.ComponentProps<typeof ExpoTCaption>;

const Table = React.forwardRef<
  ViewInstance,
  ITableProps
>(({ className, ...props }, ref) => {
  return (
    <ExpoTable
      ref={ref as React.ComponentProps<typeof ExpoTable>["ref"]}
      className={tableStyle({ class: className })}
      {...props}
    />
  );
});

const TableHeader = React.forwardRef<
  ViewInstance,
  ITableHeaderProps
>(function TableHeader({ className, ...props }, ref) {
  const contextValue = useMemo(() => {
    return {
      isHeaderRow: true,
    };
  }, []);
  return (
    <TableHeaderContext.Provider value={contextValue}>
      <ExpoTHead
        ref={ref as React.ComponentProps<typeof ExpoTHead>["ref"]}
        className={tableHeaderStyle({ class: className })}
        {...props}
      />
    </TableHeaderContext.Provider>
  );
});

const TableBody = React.forwardRef<
  ViewInstance,
  ITableBodyProps
>(function TableBody({ className, ...props }, ref) {
  return (
    <ExpoTBody
      ref={ref as React.ComponentProps<typeof ExpoTBody>["ref"]}
      className={tableBodyStyle({ class: className })}
      {...props}
    />
  );
});

const TableFooter = React.forwardRef<
  ViewInstance,
  ITableFooterProps
>(function TableFooter({ className, ...props }, ref) {
  const contextValue = useMemo(() => {
    return {
      isFooterRow: true,
    };
  }, []);
  return (
    <TableFooterContext.Provider value={contextValue}>
      <ExpoTFoot
        ref={ref as React.ComponentProps<typeof ExpoTFoot>["ref"]}
        className={tableFooterStyle({ class: className })}
        {...props}
      />
    </TableFooterContext.Provider>
  );
});

const TableHead = React.forwardRef<
  ViewInstance | React.ComponentRef<typeof Text>,
  ITableHeadProps
>(function TableHead({ useRNView = false, className, ...props }, ref) {
  if (useRNView) {
    return (
      <View
        ref={ref as React.Ref<ViewInstance>}
        className={tableHeadStyle({ class: className })}
        {...(props as any)}
      />
    );
  } else {
    return (
      <Text
        ref={ref as React.Ref<React.ComponentRef<typeof Text>>}
        className={tableHeadStyle({ class: className })}
        {...(props as any)}
      />
    );
  }
});

const TableRow = React.forwardRef<
  ViewInstance,
  ITableRowProps
>(function TableRow({ className, ...props }, ref) {
  const { isHeaderRow } = useContext(TableHeaderContext);
  const { isFooterRow } = useContext(TableFooterContext);

  return (
    <ExpoTR
      ref={ref as React.ComponentProps<typeof ExpoTR>["ref"]}
      className={tableRowStyleStyle({
        isHeaderRow,
        isFooterRow,
        class: className,
      })}
      {...props}
    />
  );
});

const TableData = React.forwardRef<
  ViewInstance | React.ComponentRef<typeof Text>,
  ITableDataProps
>(function TableData({ useRNView = false, className, ...props }, ref) {
  if (useRNView) {
    return (
      <View
        ref={ref as React.Ref<ViewInstance>}
        className={tableDataStyle({ class: className })}
        {...(props as any)}
      />
    );
  } else {
    return (
      <Text
        ref={ref as React.Ref<React.ComponentRef<typeof Text>>}
        className={tableDataStyle({ class: className })}
        {...(props as any)}
      />
    );
  }
});

const TableCaption = React.forwardRef<
  React.ComponentRef<typeof Text>,
  ITableCaptionProps
>(({ className, ...props }, ref) => {
  return (
    <ExpoTCaption
      ref={ref as React.ComponentProps<typeof ExpoTCaption>["ref"]}
      className={tableCaptionStyle({ class: className })}
      {...props}
    />
  );
});

Table.displayName = 'Table';
TableHeader.displayName = 'TableHeader';
TableBody.displayName = 'TableBody';
TableFooter.displayName = 'TableFooter';
TableHead.displayName = 'TableHead';
TableRow.displayName = 'TableRow';
TableData.displayName = 'TableData';
TableCaption.displayName = 'TableCaption';

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableData,
  TableCaption,
};
